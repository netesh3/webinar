package engage

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif" // first frame of a GIF
	"image/jpeg"
	"image/png"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

/* Header and carousel-card images, made acceptable to WhatsApp on upload instead of
 * sending the coach back to an image editor.
 *
 * Meta takes JPEG or PNG up to 5 MB for a template image
 * (developers.facebook.com/docs/whatsapp/cloud-api/reference/media). A phone photo is
 * often a 12-megapixel JPEG on its side with the rotation only in its EXIF, a WebP from
 * a website, or a GIF. So every image is decoded, turned the right way up, cropped to
 * the carousel's shape when it is a card, scaled down, and re-encoded — which also
 * drops the metadata (location included) that a photo carries.
 *
 * Videos and documents are not touched: there is no transcoder on Cloud Run, and Meta
 * plays or refuses them as they are. */

const (
	// maxImageSide is the longest side kept. WhatsApp shows a header a few hundred
	// pixels wide; 1600 stays sharp on a high-density phone and keeps files small.
	maxImageSide = 1600
	// maxImageBytes is Meta's limit for a template image.
	maxImageBytes = 5 << 20
	// maxImageInput is how large an upload may be before processing. A camera original
	// is often well over 5 MB, and that is exactly the file this exists to fix.
	maxImageInput = 25 << 20
)

// Card aspects: Meta requires every card in a carousel to have the same shape.
const (
	aspectKeep   = ""
	aspectSquare = "square" // 1:1
	aspectWide   = "wide"   // 1.91:1, the ratio WhatsApp crops wide images to
)

func validAspect(a string) bool {
	return a == aspectKeep || a == aspectSquare || a == aspectWide
}

// processedImage is an image ready to store and send.
type processedImage struct {
	Data   []byte
	Mime   string
	Width  int
	Height int
}

var errImageUndecodable = errors.New("that image could not be read — export it as JPG or PNG and try again")

/* processImage decodes, orients, crops (to aspect, for a card), scales and re-encodes.
 * A PNG with real transparency stays PNG when it fits; everything else becomes JPEG. */
func processImage(data []byte, aspect string) (processedImage, error) {
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return processedImage{}, errImageUndecodable
	}
	if format == "jpeg" {
		img = orient(img, exifOrientation(data))
	}
	img = cropToAspect(img, aspect)
	img = scaleDown(img, maxImageSide)

	if format == "png" && hasTransparency(img) {
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err == nil && buf.Len() <= maxImageBytes {
			b := img.Bounds()
			return processedImage{Data: buf.Bytes(), Mime: "image/png", Width: b.Dx(), Height: b.Dy()}, nil
		}
	}
	flat := flatten(img)
	for side := maxImageSide; side >= 400; side = side * 4 / 5 {
		scaled := scaleDown(flat, side)
		for q := 90; q >= 50; q -= 10 {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, scaled, &jpeg.Options{Quality: q}); err != nil {
				return processedImage{}, err
			}
			if buf.Len() <= maxImageBytes {
				b := scaled.Bounds()
				return processedImage{Data: buf.Bytes(), Mime: "image/jpeg", Width: b.Dx(), Height: b.Dy()}, nil
			}
		}
	}
	return processedImage{}, fmt.Errorf("that image is still over 5 MB after shrinking it — use a simpler picture")
}

// flatten draws img over white, so transparency becomes white rather than black in a JPEG.
func flatten(img image.Image) *image.RGBA {
	b := img.Bounds()
	out := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(out, out.Bounds(), img, b.Min, draw.Over)
	return out
}

func hasTransparency(img image.Image) bool {
	if o, ok := img.(interface{ Opaque() bool }); ok {
		return !o.Opaque()
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a < 0xffff {
				return true
			}
		}
	}
	return false
}

// scaleDown shrinks img so its longest side is at most side. It never enlarges.
func scaleDown(img image.Image, side int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= side && h <= side {
		return img
	}
	nw, nh := side, h*side/w
	if h > w {
		nw, nh = w*side/h, side
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	out := image.NewRGBA(image.Rect(0, 0, nw, nh))
	xdraw.CatmullRom.Scale(out, out.Bounds(), img, b, xdraw.Src, nil)
	return out
}

// cropToAspect center-crops to the card shape. aspectKeep leaves the image as it is.
func cropToAspect(img image.Image, aspect string) image.Image {
	var num, den int
	switch aspect {
	case aspectSquare:
		num, den = 1, 1
	case aspectWide:
		num, den = 191, 100
	default:
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	// Target width:height = num:den. Crop whichever side is too long.
	cw, ch := w, w*den/num
	if ch > h {
		cw, ch = h*num/den, h
	}
	x0 := b.Min.X + (w-cw)/2
	y0 := b.Min.Y + (h-ch)/2
	out := image.NewRGBA(image.Rect(0, 0, cw, ch))
	draw.Draw(out, out.Bounds(), img, image.Point{X: x0, Y: y0}, draw.Src)
	return out
}

/* orient applies an EXIF orientation (1–8). Phones save the sensor's pixels and record
 * how to turn them; WhatsApp would show the raw pixels, so the turn is done here. */
func orient(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	out := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			out.Set(dx, dy, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return out
}

/* exifOrientation reads tag 0x0112 from a JPEG's APP1 Exif segment, or 1 when there is
 * none. Only the one tag is read; malformed data is treated as "no rotation". */
func exifOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		if marker == 0xDA || marker == 0xD9 { // start of scan / end of image
			return 1
		}
		size := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if size < 2 || i+2+size > len(data) {
			return 1
		}
		seg := data[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:8]))
	if off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off : off+2]))
	for k := 0; k < n; k++ {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 {
			v := int(bo.Uint16(t[e+8 : e+10]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}
