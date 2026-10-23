// Package mp4probe reads what an uploaded video is from its MP4/MOV box structure: the
// container, how long it runs, and the codecs of its first video and audio tracks.
//
// Pure Go and read-only, because there is no ffprobe on Cloud Run. It reads box headers and
// the moov box only, seeking past everything else, so on object storage it is a handful of
// ranged GETs however large the file is — wherever moov sits, start (fast start) or end.
package mp4probe

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Info is what the probe found.
type Info struct {
	// Container is "mp4" or "mov" (QuickTime, ftyp brand "qt  ").
	Container  string
	Brand      string
	DurationMs int64
	// VideoCodec and AudioCodec are the sample entry four-character codes of the first track
	// of each kind ("avc1", "mp4a"); AudioCodec is empty for a silent video.
	VideoCodec string
	AudioCodec string
	Width      int
	Height     int
	// FastStart says moov comes before the media data, so playback can begin at once.
	FastStart bool
}

var (
	// ErrNotMP4 is a file that is not an ISO base media (MP4/MOV) file at all.
	ErrNotMP4 = errors.New("not an MP4 or MOV file")
	// ErrWebM is a Matroska/WebM file, recognised so the refusal can say what it is.
	ErrWebM = errors.New("a WebM or MKV file")
	// ErrNoMovie is an MP4 without a readable moov box (cut short, or still being written).
	ErrNoMovie  = errors.New("no movie header")
	ErrNoVideo  = errors.New("no video track")
	ErrNoLength = errors.New("no duration")
)

// UnsupportedCodecError is a track in a codec browsers cannot all play.
type UnsupportedCodecError struct {
	Kind  string // "video" or "audio"
	Codec string
}

func (e *UnsupportedCodecError) Error() string {
	return fmt.Sprintf("unsupported %s codec %q", e.Kind, e.Codec)
}

// Bounds on what is read into memory: moov holds the sample tables, which for hours of
// video are a few tens of MB at most.
const (
	maxMoov     = 128 << 20
	maxTopBoxes = 1024
)

// Supported codecs: H.264 video and AAC audio play in every browser the player supports.
var (
	videoOK = map[string]bool{"avc1": true, "avc3": true}
	audioOK = map[string]bool{"mp4a": true}
)

/* Probe reads r (size bytes long). It refuses — with an error the caller turns into words —
 * anything that is not an MP4/MOV with an H.264 video track and AAC (or no) audio, and one
 * whose duration cannot be read. */
func Probe(r io.ReadSeeker, size int64) (Info, error) {
	var (
		info    Info
		moov    []byte
		pos     int64
		sawMdat bool
		hdr     [16]byte
	)
	for n := 0; pos < size && n < maxTopBoxes; n++ {
		if _, err := r.Seek(pos, io.SeekStart); err != nil {
			return Info{}, err
		}
		got, err := io.ReadFull(r, hdr[:8])
		if err != nil {
			if n == 0 && got >= 4 && binary.BigEndian.Uint32(hdr[:4]) == 0x1A45DFA3 {
				return Info{}, ErrWebM
			}
			if n == 0 {
				return Info{}, ErrNotMP4
			}
			break
		}
		if n == 0 && binary.BigEndian.Uint32(hdr[:4]) == 0x1A45DFA3 {
			return Info{}, ErrWebM
		}
		boxSize := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		headerLen := int64(8)
		switch boxSize {
		case 1:
			if _, err := io.ReadFull(r, hdr[8:16]); err != nil {
				return Info{}, ErrNotMP4
			}
			boxSize = int64(binary.BigEndian.Uint64(hdr[8:16]))
			headerLen = 16
		case 0:
			boxSize = size - pos
		}
		if n == 0 && !topLevel[typ] {
			return Info{}, ErrNotMP4
		}
		if boxSize < headerLen || pos+boxSize > size {
			if typ == "moov" {
				return Info{}, ErrNoMovie
			}
			break
		}
		body := boxSize - headerLen
		switch typ {
		case "ftyp":
			b, err := readN(r, min(body, 4096))
			if err != nil {
				return Info{}, ErrNotMP4
			}
			if len(b) >= 4 {
				info.Brand = string(b[:4])
			}
		case "moov":
			if body > maxMoov {
				return Info{}, ErrNoMovie
			}
			b, err := readN(r, body)
			if err != nil {
				return Info{}, ErrNoMovie
			}
			moov = b
			info.FastStart = !sawMdat
		case "mdat":
			sawMdat = true
		}
		if moov != nil {
			break
		}
		pos += boxSize
	}
	if moov == nil {
		return Info{}, ErrNoMovie
	}
	info.Container = "mp4"
	if info.Brand == "qt  " {
		info.Container = "mov"
	}
	if err := parseMoov(moov, &info); err != nil {
		return Info{}, err
	}
	if info.VideoCodec == "" {
		return Info{}, ErrNoVideo
	}
	if !videoOK[info.VideoCodec] {
		return Info{}, &UnsupportedCodecError{Kind: "video", Codec: info.VideoCodec}
	}
	if info.AudioCodec != "" && !audioOK[info.AudioCodec] {
		return Info{}, &UnsupportedCodecError{Kind: "audio", Codec: info.AudioCodec}
	}
	if info.DurationMs <= 0 {
		return Info{}, ErrNoLength
	}
	return info, nil
}

// topLevel is the boxes an MP4/MOV may start with.
var topLevel = map[string]bool{
	"ftyp": true, "moov": true, "mdat": true, "free": true, "skip": true, "wide": true,
	"pnot": true, "uuid": true, "styp": true,
}

func readN(r io.Reader, n int64) ([]byte, error) {
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return b, err
}

// box is one child box inside a parent's payload.
type box struct {
	typ  string
	body []byte
}

// children splits a payload into its boxes, stopping at the first malformed one.
func children(b []byte) []box {
	var out []box
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b[:4]))
		typ := string(b[4:8])
		hl := uint64(8)
		if size == 1 {
			if len(b) < 16 {
				break
			}
			size = binary.BigEndian.Uint64(b[8:16])
			hl = 16
		} else if size == 0 {
			size = uint64(len(b))
		}
		if size < hl || size > uint64(len(b)) {
			break
		}
		out = append(out, box{typ: typ, body: b[hl:size]})
		b = b[size:]
	}
	return out
}

func child(b []byte, path ...string) []byte {
	for _, want := range path {
		found := false
		for _, c := range children(b) {
			if c.typ == want {
				b, found = c.body, true
				break
			}
		}
		if !found {
			return nil
		}
	}
	return b
}

func parseMoov(moov []byte, info *Info) error {
	movieMs := int64(0)
	if mvhd := child(moov, "mvhd"); mvhd != nil {
		movieMs = headerDuration(mvhd)
	}
	trackMs := int64(0)
	for _, c := range children(moov) {
		if c.typ != "trak" {
			continue
		}
		mdia := child(c.body, "mdia")
		if mdia == nil {
			continue
		}
		handler := ""
		if hdlr := child(mdia, "hdlr"); len(hdlr) >= 12 {
			handler = string(hdlr[8:12])
		}
		if mdhd := child(mdia, "mdhd"); mdhd != nil {
			trackMs = max(trackMs, headerDuration(mdhd))
		}
		stsd := child(mdia, "minf", "stbl", "stsd")
		if len(stsd) < 8 {
			continue
		}
		entries := children(stsd[8:]) // past version/flags and entry_count
		if len(entries) == 0 {
			continue
		}
		codec := entries[0].typ
		switch handler {
		case "vide":
			if info.VideoCodec == "" {
				info.VideoCodec = codec
				// VisualSampleEntry: 6 reserved, 2 data ref, 16 pre-defined/reserved, then w, h.
				if e := entries[0].body; len(e) >= 28 {
					info.Width = int(binary.BigEndian.Uint16(e[24:26]))
					info.Height = int(binary.BigEndian.Uint16(e[26:28]))
				}
			}
		case "soun":
			if info.AudioCodec == "" {
				info.AudioCodec = codec
			}
		}
	}
	info.DurationMs = movieMs
	if info.DurationMs <= 0 {
		info.DurationMs = trackMs
	}
	if info.DurationMs <= 0 {
		// A fragmented MP4 carries its length in mvex/mehd, in the movie timescale.
		if mehd := child(moov, "mvex", "mehd"); mehd != nil {
			if mvhd := child(moov, "mvhd"); mvhd != nil {
				info.DurationMs = scaled(mehdDuration(mehd), timescaleOf(mvhd))
			}
		}
	}
	return nil
}

// headerDuration is an mvhd's or mdhd's duration in ms (both lay out version, times, scale, duration).
func headerDuration(b []byte) int64 {
	if len(b) < 4 {
		return 0
	}
	if b[0] == 1 {
		if len(b) < 32 {
			return 0
		}
		return scaled(binary.BigEndian.Uint64(b[24:32]), binary.BigEndian.Uint32(b[20:24]))
	}
	if len(b) < 20 {
		return 0
	}
	d := binary.BigEndian.Uint32(b[16:20])
	if d == 0xFFFFFFFF { // "unknown"
		return 0
	}
	return scaled(uint64(d), binary.BigEndian.Uint32(b[12:16]))
}

func timescaleOf(mvhd []byte) uint32 {
	if len(mvhd) >= 24 && mvhd[0] == 1 {
		return binary.BigEndian.Uint32(mvhd[20:24])
	}
	if len(mvhd) >= 16 {
		return binary.BigEndian.Uint32(mvhd[12:16])
	}
	return 0
}

func mehdDuration(b []byte) uint64 {
	if len(b) >= 12 && b[0] == 1 {
		return binary.BigEndian.Uint64(b[4:12])
	}
	if len(b) >= 8 {
		return uint64(binary.BigEndian.Uint32(b[4:8]))
	}
	return 0
}

func scaled(d uint64, timescale uint32) int64 {
	if timescale == 0 || d == 0 {
		return 0
	}
	// Whole seconds and the remainder apart, so a long file in a fine timescale cannot overflow.
	return int64(d/uint64(timescale))*1000 + int64(d%uint64(timescale)*1000/uint64(timescale))
}
