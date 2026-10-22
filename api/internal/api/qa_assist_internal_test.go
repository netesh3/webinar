package api

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func TestQANormalize(t *testing.T) {
	for in, want := range map[string]string{
		"What's the fee??":     "whats the fee",
		"  whats   THE fee ":   "whats the fee",
		"Fees kitni hai, sir?": "fees kitni hai sir",
		"Recording milega?!":   "recording milega",
		"???":                  "",
		"Is it ₹499 or ₹999?":  "is it 499 or 999",
		"क्या रिकॉर्डिंग मिलेगी?": "क्या रिकॉर्डिंग मिलेगी",
	} {
		if got := qaNormalize(in); got != want {
			t.Errorf("qaNormalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestQAClusterDueBatches(t *testing.T) {
	now := time.Now()
	fresh := now.Add(-time.Second)
	if qaClusterDue(0, fresh, now) {
		t.Error("nothing pending is due")
	}
	if qaClusterDue(1, fresh, now) || qaClusterDue(2, fresh, now) {
		t.Error("one or two fresh questions must wait for the batch")
	}
	if !qaClusterDue(qaClusterBatch, fresh, now) {
		t.Error("a full batch is due at once")
	}
	if !qaClusterDue(1, now.Add(-qaClusterEvery), now) {
		t.Error("one question waiting qaClusterEvery is due")
	}
}

func TestPlanQAClustersPrePass(t *testing.T) {
	at := time.Now()
	qs := []store.QAQuestion{
		{ID: "a", Text: "Will there be a recording?", ClusterID: "qc_rec", Canonical: "Is the session recorded?", CreatedAt: at},
		{ID: "b", Text: "will there be a RECORDING", CreatedAt: at}, // joins qc_rec by text
		{ID: "c", Text: "Is the session recorded", CreatedAt: at},   // joins qc_rec by its wording
		{ID: "d", Text: "What's the fee?", CreatedAt: at},           // new group
		{ID: "e", Text: "whats the fee", CreatedAt: at},             // same group as d
		{ID: "f", Text: "Can I pay in instalments?", CreatedAt: at}, // new group
		{ID: "g", Text: "???", CreatedAt: at},                       // empty text never merges
		{ID: "h", Text: "!!", CreatedAt: at},
	}
	p := planQAClusters(qs)
	if p.assign["b"] != "qc_rec" || p.assign["c"] != "qc_rec" || len(p.assign) != 2 {
		t.Fatalf("assign = %v", p.assign)
	}
	if len(p.existing) != 1 || p.existing[0].id != "qc_rec" {
		t.Fatalf("existing = %+v", p.existing)
	}
	if len(p.groups) != 4 {
		t.Fatalf("groups = %+v, want fee, instalments and two lone punctuations", p.groups)
	}
	if g := p.groups[0]; len(g.ids) != 2 || g.ids[0] != "d" || g.ids[1] != "e" {
		t.Fatalf("fee group = %+v", g)
	}
}

func TestQARankingAndClusters(t *testing.T) {
	now := time.Now()
	qs := []store.QAQuestion{
		{ID: "1", Identity: "a", Text: "Fee?", Upvotes: 1, ClusterID: "qc_fee", Canonical: "What is the fee?", CreatedAt: now.Add(-30 * time.Minute)},
		{ID: "2", Identity: "b", Text: "Cost?", Upvotes: 2, ClusterID: "qc_fee", Canonical: "What is the fee?", CreatedAt: now.Add(-20 * time.Minute)},
		{ID: "3", Identity: "b", Text: "Price?", Upvotes: 0, ClusterID: "qc_fee", Canonical: "What is the fee?", CreatedAt: now.Add(-20 * time.Minute)},
		{ID: "4", Identity: "c", Text: "Recording?", Upvotes: 0, CreatedAt: now},
		{ID: "5", Identity: "d", Text: "Done one", Answered: true, ClusterID: "qc_done", Canonical: "Done", CreatedAt: now},
	}
	cs := buildQAClusters(qs, now)
	if len(cs) != 3 {
		t.Fatalf("clusters = %+v", cs)
	}
	fee := cs[0]
	if fee.ID != "qc_fee" || fee.Askers != 2 || fee.Upvotes != 3 || fee.Open != 3 || len(fee.QuestionIDs) != 3 {
		t.Fatalf("fee cluster = %+v", fee)
	}
	rec := cs[1]
	if rec.ID != "q_4" || !rec.Provisional || rec.Canonical != "Recording?" {
		t.Fatalf("pending question = %+v", rec)
	}
	// fee: 3 + 4 + 5*0.5^4 = 7.31; recording: 0 + 2 + 5 = 7. The answered one is out.
	top := rankQAClusters(cs, 3)
	if len(top) != 2 || top[0] != "qc_fee" || top[1] != "q_4" {
		t.Fatalf("top = %v (scores %v %v)", top, fee.Score, rec.Score)
	}
	// Recency matters: the same votes, asked now, beat the old cluster.
	if qaScore(3, 2, 0) <= qaScore(3, 2, time.Hour) {
		t.Fatal("recency did not count")
	}
	// One open cluster: no strip.
	if got := rankQAClusters([]types.QACluster{{ID: "x", Open: 1}}, 3); len(got) != 0 {
		t.Fatalf("top of one = %v", got)
	}
}

func TestParseQAClustersPlacesEveryQuestionOnce(t *testing.T) {
	groups, err := aiwrite.ParseQAClusters(`{"groups":[
		{"existing":"c1","canonical":"","questions":["n2","n9"]},
		{"existing":"","canonical":"What is the fee?","questions":["n1","n2","n3"]},
		{"existing":"c7","canonical":"x","questions":[]}]}`, 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	// n2 stays in its first group, n9 and c7 are unknown, n4 was left out and is its own.
	if len(groups) != 3 {
		t.Fatalf("groups = %+v", groups)
	}
	if g := groups[0]; g.Existing != 0 || len(g.Questions) != 1 || g.Questions[0] != 1 {
		t.Fatalf("existing group = %+v", g)
	}
	if g := groups[1]; g.Existing != -1 || len(g.Questions) != 2 || g.Canonical != "What is the fee?" {
		t.Fatalf("new group = %+v", g)
	}
	if g := groups[2]; g.Existing != -1 || len(g.Questions) != 1 || g.Questions[0] != 3 {
		t.Fatalf("left-out question = %+v", g)
	}
}
