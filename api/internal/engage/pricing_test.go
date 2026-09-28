package engage

import "testing"

func TestParseRatesOverridesBuiltIn(t *testing.T) {
	table, err := ParseRates("IN:utility=200000, US=40000")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := table.Lookup("IN", "utility"); !ok || got != 200_000 {
		t.Fatalf("IN utility = %d ok=%v, want 200000", got, ok)
	}
	// A key the override did not mention stays on the built-in card.
	if got, ok := table.Lookup("IN", "marketing"); !ok || got != 780_000 {
		t.Fatalf("IN marketing = %d ok=%v, want the built-in 780000", got, ok)
	}
	if got, ok := table.Lookup("US", "utility"); !ok || got != 40_000 {
		t.Fatalf("US fallback = %d ok=%v", got, ok)
	}
	if _, err := ParseRates("not-a-rate"); err == nil {
		t.Fatal("bad entry should fail")
	}
}

func TestQuoteEstimatesWhenMetaOmitsTheAmount(t *testing.T) {
	table := DefaultRates()
	billable := true
	cat, micros, estimated, ok := Quote(table, PriceInput{
		Category: "utility", Billable: &billable, Recipient: "919800011122",
	})
	if !ok || cat != "utility" || !estimated || micros == nil || *micros != 130_000 {
		t.Fatalf("quote = %q %v estimated=%v ok=%v, want utility 130000 estimated", cat, micros, estimated, ok)
	}

	cat, micros, estimated, ok = Quote(table, PriceInput{
		Category: "marketing", Billable: &billable, HasAmount: true, Micros: 780_000, Recipient: "919800011122",
	})
	if !ok || estimated || micros == nil || *micros != 780_000 {
		t.Fatalf("exact amount estimated=%v micros=%v", estimated, micros)
	}

	free := false
	cat, micros, estimated, ok = Quote(table, PriceInput{
		Category: "service", Billable: &free, Recipient: "919800011122",
	})
	if !ok || estimated || micros == nil || *micros != 0 {
		t.Fatalf("not billable = %v estimated=%v", micros, estimated)
	}

	// A country with no row keeps the category and leaves the cost empty.
	cat, micros, estimated, ok = Quote(table, PriceInput{
		Category: "utility", Billable: &billable, Recipient: "14155550100",
	})
	if !ok || cat != "utility" || micros != nil || estimated {
		t.Fatalf("unknown country should not invent a charge: cat=%q micros=%v estimated=%v", cat, micros, estimated)
	}
}

func TestCountryFromPhone(t *testing.T) {
	if got := CountryFromPhone("+91 98200 11223"); got != "IN" {
		t.Fatalf("India = %q", got)
	}
	if got := CountryFromPhone("18681234567"); got != "TT" {
		t.Fatalf("Trinidad should win over the US prefix, got %q", got)
	}
	if got := CountryFromPhone("14155550100"); got != "US" {
		t.Fatalf("US = %q", got)
	}
}

func TestExplainFailureUsesTheCode(t *testing.T) {
	f := ExplainFailure("131042: There is no payment method on this account.", 4)
	if f.Code != "131042" || f.Count != 4 || f.Fix == "" || f.Reason == "" {
		t.Fatalf("failure = %+v", f)
	}
	if f.Reason == "There is no payment method on this account." {
		t.Fatal("the page should say what to do, not only repeat Meta")
	}
	plain := ExplainFailure("something Meta invented", 1)
	if plain.Code != "" || plain.Reason != "something Meta invented" || plain.Fix == "" {
		t.Fatalf("unknown error = %+v", plain)
	}
}
