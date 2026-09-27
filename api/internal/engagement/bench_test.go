package engagement

import (
	"encoding/json"
	"testing"
)

/* BenchmarkCompute is the aggregation alone, on inputs shaped like the targets: a
 * 5,000-person webinar with ~100k captured events. Run with
 *
 *	go test ./internal/engagement -bench Compute -benchmem -run '^$'
 */
func BenchmarkCompute(b *testing.B) {
	for _, c := range []struct {
		name string
		spec SyntheticSpec
	}{
		{"500x10k_60min", SyntheticSpec{Attendees: 500, SessionMin: 60, Events: 10_000, Seed: 1}},
		{"5000x100k_90min", SyntheticSpec{Attendees: 5000, SessionMin: 90, Events: 100_000, Seed: 2}},
		{"5000x100k_4h", SyntheticSpec{Attendees: 5000, SessionMin: 240, Events: 100_000, Seed: 3}},
	} {
		in := Synthetic(c.spec)
		f := Current()
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			var res Result
			for b.Loop() {
				res = Compute(in, f)
			}
			raw, _ := json.Marshal(res.Summary)
			b.ReportMetric(float64(len(raw))/1024, "summaryKiB")
			row, _ := json.Marshal(res.Rows[0].Row)
			b.ReportMetric(float64(len(row)), "rowBytes")
		})
	}
}

func TestSyntheticScaleIsComfortable(t *testing.T) {
	if testing.Short() {
		t.Skip("scale check")
	}
	in := Synthetic(SyntheticSpec{Attendees: 5000, SessionMin: 90, Events: 100_000, Seed: 2})
	res := Compute(in, Current())
	if len(res.Rows) != 5000 {
		t.Fatalf("%d rows", len(res.Rows))
	}
	raw, _ := json.Marshal(res.Summary)
	if len(raw) > 64*1024 {
		t.Fatalf("summary is %d bytes; the page reads it whole and it should stay small", len(raw))
	}
}
