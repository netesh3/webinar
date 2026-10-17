package engage

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"testing"
)

/* Header and card images are fixed on upload: each input WhatsApp would refuse or show
 * badly comes out as a JPEG (or a transparent PNG) under 5 MB, the right way up, at most
 * 1600 pixels on its longest side, and — for a carousel — all one shape. */

// solid is a w×h image, left half red and right half blue, so a turn or crop is visible.
func solid(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{200, 30, 30, 255}
			if x >= w/2 {
				c = color.RGBA{30, 30, 200, 255}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// withOrientation inserts an Exif APP1 segment carrying orientation o after the SOI.
func withOrientation(jpg []byte, o uint16) []byte {
	tiff := []byte("II*\x00\x08\x00\x00\x00")
	ifd := make([]byte, 2+12+4)
	binary.LittleEndian.PutUint16(ifd[0:], 1)
	binary.LittleEndian.PutUint16(ifd[2:], 0x0112)
	binary.LittleEndian.PutUint16(ifd[4:], 3) // SHORT
	binary.LittleEndian.PutUint32(ifd[6:], 1)
	binary.LittleEndian.PutUint16(ifd[10:], o)
	payload := append(append([]byte("Exif\x00\x00"), tiff...), ifd...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	seg = append(seg, payload...)
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}

func decoded(t *testing.T, p processedImage) image.Image {
	t.Helper()
	img, _, err := image.Decode(bytes.NewReader(p.Data))
	if err != nil {
		t.Fatalf("output does not decode: %v", err)
	}
	if b := img.Bounds(); b.Dx() != p.Width || b.Dy() != p.Height {
		t.Errorf("reported %dx%d, file is %dx%d", p.Width, p.Height, b.Dx(), b.Dy())
	}
	return img
}

func isRed(c color.Color) bool  { r, _, b, _ := c.RGBA(); return r > b*2 }
func isBlue(c color.Color) bool { r, _, b, _ := c.RGBA(); return b > r*2 }

func TestProcessImageJPEGIsScaledAndStripped(t *testing.T) {
	in := withOrientation(encodeJPEG(t, solid(3200, 1600)), 1)
	p, err := processImage(in, aspectKeep)
	if err != nil {
		t.Fatal(err)
	}
	if p.Mime != "image/jpeg" || p.Width != 1600 || p.Height != 800 {
		t.Errorf("got %s %dx%d, want image/jpeg 1600x800", p.Mime, p.Width, p.Height)
	}
	if bytes.Contains(p.Data, []byte("Exif")) {
		t.Errorf("metadata must be dropped (a phone photo's carries its location)")
	}
	decoded(t, p)
}

func TestProcessImageAppliesOrientation(t *testing.T) {
	// Orientation 6: the sensor's pixels need a quarter turn clockwise. The red left half
	// of a 40×20 image becomes the top half of a 20×40 one.
	p, err := processImage(withOrientation(encodeJPEG(t, solid(40, 20)), 6), aspectKeep)
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 20 || p.Height != 40 {
		t.Fatalf("got %dx%d, want 20x40", p.Width, p.Height)
	}
	img := decoded(t, p)
	if !isRed(img.At(10, 5)) || !isBlue(img.At(10, 35)) {
		t.Errorf("top %v bottom %v, want red over blue", img.At(10, 5), img.At(10, 35))
	}
	if exifOrientation(encodeJPEG(t, solid(4, 4))) != 1 {
		t.Errorf("no Exif is orientation 1")
	}
}

func TestProcessImagePNG(t *testing.T) {
	var opaque bytes.Buffer
	_ = png.Encode(&opaque, solid(100, 50))
	p, err := processImage(opaque.Bytes(), aspectKeep)
	if err != nil || p.Mime != "image/jpeg" {
		t.Errorf("an opaque PNG becomes JPEG: %s %v", p.Mime, err)
	}

	clear := image.NewNRGBA(image.Rect(0, 0, 60, 30))
	clear.Set(5, 5, color.NRGBA{255, 0, 0, 255})
	var alpha bytes.Buffer
	_ = png.Encode(&alpha, clear)
	p, err = processImage(alpha.Bytes(), aspectKeep)
	if err != nil || p.Mime != "image/png" || p.Width != 60 {
		t.Errorf("a transparent PNG stays PNG: %s %dx%d %v", p.Mime, p.Width, p.Height, err)
	}
}

func TestProcessImageWebPAndGIF(t *testing.T) {
	// A 40×20 lossless WebP, red left half and blue right (made with cwebp).
	webp, _ := base64.StdEncoding.DecodeString("UklGRioAAABXRUJQVlA4TB4AAAAvJ8AEAA8wHvdQvRXy/EcLBAKEA/+1BgRE9D9K2AM=")
	p, err := processImage(webp, aspectKeep)
	if err != nil || p.Mime != "image/jpeg" || p.Width != 40 || p.Height != 20 {
		t.Fatalf("webp: %s %dx%d %v", p.Mime, p.Width, p.Height, err)
	}
	if img := decoded(t, p); !isRed(img.At(5, 10)) || !isBlue(img.At(35, 10)) {
		t.Errorf("webp colours lost")
	}

	pal := color.Palette{color.RGBA{200, 30, 30, 255}, color.RGBA{30, 30, 200, 255}}
	frame := func(c uint8) *image.Paletted {
		f := image.NewPaletted(image.Rect(0, 0, 30, 30), pal)
		for i := range f.Pix {
			f.Pix[i] = c
		}
		return f
	}
	var g bytes.Buffer
	_ = gif.EncodeAll(&g, &gif.GIF{Image: []*image.Paletted{frame(0), frame(1)}, Delay: []int{10, 10}})
	p, err = processImage(g.Bytes(), aspectKeep)
	if err != nil || p.Mime != "image/jpeg" {
		t.Fatalf("gif: %s %v", p.Mime, err)
	}
	if img := decoded(t, p); !isRed(img.At(15, 15)) {
		t.Errorf("a GIF is its first frame (red), got %v", img.At(15, 15))
	}

	if _, err := processImage([]byte("not an image at all"), aspectKeep); err != errImageUndecodable {
		t.Errorf("garbage: %v", err)
	}
}

func TestProcessImageOversizeComesUnderFiveMB(t *testing.T) {
	// Noise is the worst case for JPEG: a 4000×3000 camera-sized original.
	rng := rand.New(rand.NewSource(1))
	img := image.NewRGBA(image.Rect(0, 0, 4000, 3000))
	rng.Read(img.Pix)
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	var in bytes.Buffer
	_ = png.Encode(&in, img)
	if in.Len() <= maxImageBytes {
		t.Fatalf("fixture is only %d bytes", in.Len())
	}
	p, err := processImage(in.Bytes(), aspectKeep)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Data) > maxImageBytes || p.Width > maxImageSide || p.Height > maxImageSide {
		t.Errorf("got %d bytes %dx%d", len(p.Data), p.Width, p.Height)
	}
}

func TestProcessImageCardAspects(t *testing.T) {
	// Every card in a carousel is cut to one shape, whatever was uploaded.
	inputs := [][]byte{encodeJPEG(t, solid(1000, 1000)), encodeJPEG(t, solid(1200, 400)), encodeJPEG(t, solid(300, 900))}
	for _, in := range inputs {
		sq, err := processImage(in, aspectSquare)
		if err != nil || sq.Width != sq.Height {
			t.Errorf("square: %dx%d %v", sq.Width, sq.Height, err)
		}
		wide, err := processImage(in, aspectWide)
		ratio := float64(wide.Width) / float64(wide.Height)
		if err != nil || ratio < 1.89 || ratio > 1.93 {
			t.Errorf("wide: %dx%d (%.3f) %v", wide.Width, wide.Height, ratio, err)
		}
	}
	// Center crop: a 1200×400 red|blue image cut square keeps the middle, both colours.
	p, _ := processImage(encodeJPEG(t, solid(1200, 400)), aspectSquare)
	img := decoded(t, p)
	if !isRed(img.At(50, 200)) || !isBlue(img.At(350, 200)) {
		t.Errorf("crop is not centred")
	}
	if validAspect("tall") {
		t.Errorf("only square and wide are card shapes")
	}
}
