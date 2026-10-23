package mp4probe_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/netkumar/webcast/api/internal/mp4probe"
	"github.com/netkumar/webcast/api/internal/mp4probe/mp4fake"
)

func probe(b []byte) (mp4probe.Info, error) {
	return mp4probe.Probe(bytes.NewReader(b), int64(len(b)))
}

func TestProbeReadsAnH264File(t *testing.T) {
	for _, last := range []bool{false, true} {
		info, err := probe(mp4fake.Build(mp4fake.Spec{Audio: "mp4a", DurationMs: 3_725_500, MoovLast: last, MdatBytes: 4096}))
		if err != nil {
			t.Fatalf("moovLast=%v: %v", last, err)
		}
		if info.Container != "mp4" || info.VideoCodec != "avc1" || info.AudioCodec != "mp4a" ||
			info.DurationMs != 3_725_500 || info.Width != 1280 || info.Height != 720 || info.FastStart == last {
			t.Fatalf("moovLast=%v: %+v", last, info)
		}
	}
}

func TestProbeAcceptsAMovAndASilentVideo(t *testing.T) {
	info, err := probe(mp4fake.Build(mp4fake.Spec{Brand: "qt  ", DurationMs: 60_000}))
	if err != nil || info.Container != "mov" || info.AudioCodec != "" {
		t.Fatalf("mov: %+v %v", info, err)
	}
}

func TestProbeRefuses(t *testing.T) {
	var codec *mp4probe.UnsupportedCodecError
	cases := []struct {
		name string
		file []byte
		want func(error) bool
	}{
		{"hevc", mp4fake.Build(mp4fake.Spec{Video: "hvc1", DurationMs: 1000}), func(e error) bool {
			return errors.As(e, &codec) && codec.Kind == "video" && codec.Codec == "hvc1"
		}},
		{"ac3 audio", mp4fake.Build(mp4fake.Spec{Audio: "ac-3", DurationMs: 1000}), func(e error) bool {
			return errors.As(e, &codec) && codec.Kind == "audio"
		}},
		{"audio only", mp4fake.Build(mp4fake.Spec{Video: "-", Audio: "mp4a", DurationMs: 1000}), func(e error) bool {
			return errors.Is(e, mp4probe.ErrNoVideo)
		}},
		{"no duration", mp4fake.Build(mp4fake.Spec{DurationMs: 0}), func(e error) bool {
			return errors.Is(e, mp4probe.ErrNoLength)
		}},
		{"webm", []byte{0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0}, func(e error) bool {
			return errors.Is(e, mp4probe.ErrWebM)
		}},
		{"text", []byte("hello, this is not a video at all"), func(e error) bool {
			return errors.Is(e, mp4probe.ErrNotMP4)
		}},
		{"cut short", mp4fake.Build(mp4fake.Spec{DurationMs: 1000, MoovLast: true, MdatBytes: 100})[:150], func(e error) bool {
			return errors.Is(e, mp4probe.ErrNoMovie)
		}},
	}
	for _, c := range cases {
		if _, err := probe(c.file); !c.want(err) {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
}
