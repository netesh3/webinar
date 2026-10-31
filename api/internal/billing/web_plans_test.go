package billing_test

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The pricing pages' copy of the plans, web/lib/plans.ts, read back and held to this
 * package's Plans and store.TierFeatures (31 Oct 2026). The /pricing cards read the server's
 * catalogue; the "Compare all features" table and /features read that file. So every price,
 * list price, cap, card line and tier switch there must be the server's, and the yearly list
 * rule must be billing.YearlyList. */

func readWebPlans(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../../../web/lib/plans.ts")
	if err != nil {
		t.Skipf("web/lib/plans.ts not beside the api (%v)", err)
	}
	return string(raw)
}

var (
	reMoney  = regexp.MustCompile(`\{ INR: (\d+), USD: (\d+) \}`)
	reInt    = func(key string) *regexp.Regexp { return regexp.MustCompile(`\n\s+` + key + `: (\d+),`) }
	reQuoted = regexp.MustCompile(`"([^"]*)"`)
	// One plan's list in TIER_FEATURES, on one line or several.
	reTier = regexp.MustCompile(`(?s)\n\s*(\w+): \[([^\]]*)\]`)
)

func TestWebPlansMatchTheServer(t *testing.T) {
	src := readWebPlans(t)
	start := strings.Index(src, "export const PLANS: Plan[] = [")
	end := strings.Index(src, "export const TIER_FEATURES")
	if start < 0 || end < start {
		t.Fatal("PLANS or TIER_FEATURES not found in web/lib/plans.ts")
	}
	blocks := strings.Split(src[start:end], `server: "`)[1:]
	onSale := billing.OnSale()
	if len(blocks) != len(onSale) {
		t.Fatalf("web has %d plans, the server sells %d", len(blocks), len(onSale))
	}
	for i, b := range blocks {
		p := onSale[i]
		if id := b[:strings.Index(b, `"`)]; id != string(p.ID) {
			t.Fatalf("web plan %d is %q, server's is %q", i, id, p.ID)
		}
		money := func(key string) (inr, usd int64, ok bool) {
			i := strings.Index(b, "\n    "+key+": {")
			if i < 0 {
				return 0, 0, false
			}
			m := reMoney.FindStringSubmatch(b[i:])
			a, _ := strconv.ParseInt(m[1], 10, 64)
			c, _ := strconv.ParseInt(m[2], 10, 64)
			return a * 100, c * 100, true
		}
		if inr, usd, ok := money("monthly"); p.ContactOnly == ok || (ok && (inr != p.Monthly[billing.INR] || usd != p.Monthly[billing.USD])) {
			t.Errorf("%s monthly: web ₹%d $%d (priced %v), server ₹%d $%d (contact %v)", p.ID, inr/100, usd/100, ok, p.Monthly[billing.INR]/100, p.Monthly[billing.USD]/100, p.ContactOnly)
		}
		if inr, usd, _ := money("list"); inr != p.ListMonthly[billing.INR] || usd != p.ListMonthly[billing.USD] {
			t.Errorf("%s list: web ₹%d $%d, server ₹%d $%d", p.ID, inr/100, usd/100, p.ListMonthly[billing.INR]/100, p.ListMonthly[billing.USD]/100)
		}
		for key, want := range map[string]int{
			"attendees": p.Attendees(), "stage": p.StageSeats(), "meetingCap": p.MeetingSeats(), "recordingGb": p.StorageGB,
		} {
			m := reInt(key).FindStringSubmatch(b)
			if m == nil || m[1] != strconv.Itoa(want) {
				t.Errorf("%s %s: web %v, server %d", p.ID, key, m, want)
			}
		}
		if !strings.Contains(b, "\n    lead: \""+p.Lead+"\",") {
			t.Errorf("%s lead: web has none or another, server %q", p.ID, p.Lead)
		}
		h := b[strings.Index(b, "highlights: ["):]
		h = h[:strings.Index(h, "]")]
		var lines []string
		for _, m := range reQuoted.FindAllStringSubmatch(h, -1) {
			lines = append(lines, m[1])
		}
		if !slices.Equal(lines, p.Features) {
			t.Errorf("%s card lines: web %q, server %q", p.ID, lines, p.Features)
		}
	}
	if !strings.Contains(src, "export const YEARLY_OFF_PERCENT = "+strconv.Itoa(billing.YearlyOffPercent)+";") {
		t.Errorf("web YEARLY_OFF_PERCENT is not the server's %d", billing.YearlyOffPercent)
	}
}

func TestWebTierFeaturesMatchTheServer(t *testing.T) {
	src := readWebPlans(t)
	start := strings.Index(src, "export const TIER_FEATURES")
	block := src[start : start+strings.Index(src[start:], "};")]
	web := map[string][]string{}
	for _, m := range reTier.FindAllStringSubmatch(block, -1) {
		web[m[1]] = []string{}
		for _, q := range reQuoted.FindAllStringSubmatch(m[2], -1) {
			web[m[1]] = append(web[m[1]], q[1])
		}
	}
	serverOf := map[string]types.Plan{"basic": types.PlanBasic, "pro": types.PlanProfessional, "business": types.PlanBusiness, "enterprise": types.PlanEnterprise}
	if len(web) != len(store.TierFeatures) {
		t.Fatalf("web TIER_FEATURES has %d plans, store.TierFeatures %d", len(web), len(store.TierFeatures))
	}
	for id, keys := range web {
		want := slices.Clone(store.TierFeatures[serverOf[id]])
		got := slices.Clone(keys)
		slices.Sort(want)
		slices.Sort(got)
		if !slices.Equal(got, want) {
			t.Errorf("%s: web %v, server %v", id, got, want)
		}
	}
}
