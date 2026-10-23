// Package mp4fake builds tiny MP4/MOV files for tests: the box structure mp4probe reads
// (ftyp, moov with mvhd and one trak per codec, mdat), with no real media in them.
package mp4fake

import (
	"bytes"
	"encoding/binary"
)

// Spec is the file to build.
type Spec struct {
	Brand      string // "isom" by default; "qt  " for a MOV
	Video      string // "avc1" by default; "-" for no video track
	Audio      string // "" for no audio track
	DurationMs int64
	// MoovLast puts moov after mdat, as a camera writes it.
	MoovLast bool
	// MdatBytes is the padding standing in for the media.
	MdatBytes int
}

func box(typ string, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	out := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(out, clampU32(int64(8+len(body))))
	copy(out[4:], typ)
	return append(out, body...)
}

func u32(v uint32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return b
}

func u16(v uint16) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, v)
	return b
}

// header is an mvhd/mdhd payload, version 0, timescale 1000.
func header(ms int64, extra int) []byte {
	b := append([]byte{0, 0, 0, 0}, u32(0)...) // version/flags, creation
	b = append(b, u32(0)...)                   // modification
	b = append(b, u32(1000)...)                // timescale
	b = append(b, u32(clampU32(ms))...)        // duration
	return append(b, make([]byte, extra)...)
}

func trak(handler, codec string, ms int64) []byte {
	hdlr := box("hdlr", []byte{0, 0, 0, 0}, u32(0), []byte(handler), make([]byte, 13))
	var entry []byte
	if handler == "vide" {
		e := append(make([]byte, 24), u16(1280)...)
		e = append(e, u16(720)...)
		entry = box(codec, e, make([]byte, 50))
	} else {
		entry = box(codec, make([]byte, 28))
	}
	stsd := box("stsd", []byte{0, 0, 0, 0}, u32(1), entry)
	return box("trak", box("mdia",
		box("mdhd", header(ms, 4)),
		hdlr,
		box("minf", box("stbl", stsd)),
	))
}

// Build makes the file.
func Build(s Spec) []byte {
	brand := s.Brand
	if brand == "" {
		brand = "isom"
	}
	video := s.Video
	if video == "" {
		video = "avc1"
	}
	ftyp := box("ftyp", []byte(brand), u32(512), []byte("isomiso2avc1mp41"))
	parts := [][]byte{box("mvhd", header(s.DurationMs, 80))}
	if video != "-" {
		parts = append(parts, trak("vide", video, s.DurationMs))
	}
	if s.Audio != "" {
		parts = append(parts, trak("soun", s.Audio, s.DurationMs))
	}
	moov := box("moov", parts...)
	mdat := box("mdat", make([]byte, s.MdatBytes))
	if s.MoovLast {
		return bytes.Join([][]byte{ftyp, mdat, moov}, nil)
	}
	return bytes.Join([][]byte{ftyp, moov, mdat}, nil)
}

// clampU32 keeps a test duration inside the 32-bit field.
func clampU32(v int64) uint32 {
	switch {
	case v < 0:
		return 0
	case v > 0xFFFFFFFF:
		return 0xFFFFFFFF
	}
	return uint32(v)
}
