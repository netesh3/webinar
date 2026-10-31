package billing

import (
	"errors"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestQuoteAddsGSTToINROnly(t *testing.T) {
	q, err := NewQuote("professional", Monthly, INR, 18)
	if err != nil {
		t.Fatal(err)
	}
	if q.Subtotal != 9_999_00 || q.Tax != 1_799_82 || q.Total != 11_798_82 {
		t.Fatalf("INR monthly professional: %+v", q)
	}
	q, _ = NewQuote("business", Yearly, USD, 18)
	if q.Subtotal != 3_490_00 || q.Tax != 0 || q.Total != 3_490_00 {
		t.Fatalf("USD yearly business should be ten months, untaxed: %+v", q)
	}
	q, _ = NewQuote("professional", Monthly, INR, 0)
	if q.Tax != 0 || q.Total != q.Subtotal {
		t.Fatalf("0%% GST should add nothing: %+v", q)
	}
}

func TestQuoteRefusesWhatIsNotOnTheList(t *testing.T) {
	for _, c := range [][3]string{
		{"gold", Monthly, INR},
		{"business", "weekly", INR},
		{"business", Monthly, "EUR"},
	} {
		if _, err := NewQuote(c[0], c[1], c[2], 18); err == nil {
			t.Fatalf("%v should be refused", c)
		}
	}
}

func TestPaymentSignature(t *testing.T) {
	sig := Sign("secret", []byte("order_1|pay_1"))
	if !VerifyPayment("secret", "order_1", "pay_1", sig) {
		t.Fatal("valid signature refused")
	}
	if VerifyPayment("secret", "order_1", "pay_2", sig) {
		t.Fatal("signature for another payment accepted")
	}
	if VerifyPayment("other", "order_1", "pay_1", sig) {
		t.Fatal("signature with the wrong secret accepted")
	}
	if VerifyPayment("", "order_1", "pay_1", Sign("", []byte("order_1|pay_1"))) {
		t.Fatal("empty secret must never verify")
	}
}

func TestParseWebhookOnlyActsOnCapturedPayments(t *testing.T) {
	body := []byte(`{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1","order_id":"order_1","amount":100,"currency":"INR","status":"captured"}}}}`)
	p, ok := ParseWebhook(body)
	if !ok || p.PaymentID != "pay_1" || p.OrderID != "order_1" || p.Amount != 100 {
		t.Fatalf("captured payment not parsed: %+v %v", p, ok)
	}
	if _, ok := ParseWebhook([]byte(`{"event":"payment.failed","payload":{"payment":{"entity":{"id":"pay_1","order_id":"order_1","status":"failed"}}}}`)); ok {
		t.Fatal("failed payment acted on")
	}
}

// INR yearly is twelve whole months at a per-month price ending in 9, never more
// than ten monthly payments; USD stays ten times monthly.
func TestYearlyPricesAreWholeMonthsEndingInNine(t *testing.T) {
	for _, p := range Plans {
		if p.ContactOnly {
			continue
		}
		for _, cur := range []string{INR, USD} {
			m, _ := p.Price(cur, Monthly)
			y, _ := p.Price(cur, Yearly)
			if cur == USD {
				if y != m*10 {
					t.Errorf("%s USD yearly = %d, want %d", p.Name, y, m*10)
				}
				continue
			}
			if y%(12*100) != 0 || (y/12/100)%10 != 9 || y > m*10 {
				t.Errorf("%s INR yearly = %d: want 12 × a ₹…9 month, at most ten months (%d)", p.Name, y, m*10)
			}
			if l := p.List(cur, Yearly); l%(12*100) != 0 || l != YearlyList(y) {
				t.Errorf("%s INR yearly list = %d: want YearlyList, 12 whole rupee months", p.Name, l)
			}
		}
	}
	if y, _ := Plans[0].Price(INR, Yearly); y != 29_988_00 {
		t.Errorf("Basic INR yearly = %d, want ₹29,988", y)
	}
}

/* The lineup of 31 Oct 2026, as the pricing page shows it: the charge, the struck-out list
 * price and its badge, monthly and yearly, in both currencies, and the enforced caps. */
func TestPricingV3Lineup(t *testing.T) {
	type row struct {
		id                 types.Plan
		attendees, stage   int
		inr, usd           int64 // monthly charge
		inrList, usdList   int64 // monthly list, 0 for none
		inrYear, usdYear   int64 // yearly charge
		inrYList, usdYList int64 // yearly list: the charge / 0.2
	}
	want := []row{
		{types.PlanBasic, 100, 3, 2_999_00, 39_00, 7_499_00, 99_00, 29_988_00, 390_00, 1_49_940_00, 1_950_00},
		{types.PlanProfessional, 300, 5, 9_999_00, 149_00, 0, 0, 99_948_00, 1_490_00, 4_99_740_00, 7_450_00},
		{types.PlanBusiness, 500, 10, 24_999_00, 349_00, 0, 0, 2_49_948_00, 3_490_00, 12_49_740_00, 17_450_00},
	}
	for _, w := range want {
		p, ok := FindPlan(string(w.id))
		if !ok || p.ContactOnly || p.Retired {
			t.Fatalf("%s should be on sale online", w.id)
		}
		if p.Attendees() != w.attendees || p.StageSeats() != w.stage {
			t.Errorf("%s caps = %d / %d, want %d / %d", w.id, p.Attendees(), p.StageSeats(), w.attendees, w.stage)
		}
		for _, c := range []struct {
			cur, per     string
			amount, list int64
		}{
			{INR, Monthly, w.inr, w.inrList}, {USD, Monthly, w.usd, w.usdList},
			{INR, Yearly, w.inrYear, w.inrYList}, {USD, Yearly, w.usdYear, w.usdYList},
		} {
			got, _ := p.Price(c.cur, c.per)
			if got != c.amount {
				t.Errorf("%s %s %s = %d, want %d", w.id, c.cur, c.per, got, c.amount)
			}
			if l := p.List(c.cur, c.per); l != c.list {
				t.Errorf("%s %s %s list = %d, want %d", w.id, c.cur, c.per, l, c.list)
			}
		}
		// Every yearly price reads exactly 80% OFF.
		for _, cur := range []string{INR, USD} {
			y, _ := p.Price(cur, Yearly)
			if pct := DiscountPercent(y, p.List(cur, Yearly)); pct != YearlyOffPercent || OffLabel(pct) != "80% OFF" {
				t.Errorf("%s %s yearly discount = %d%%, want 80%% OFF", w.id, cur, pct)
			}
		}
	}
	// Basic's monthly price is 60% off its list, in both currencies.
	basic, _ := FindPlan("basic")
	for _, cur := range []string{INR, USD} {
		m, _ := basic.Price(cur, Monthly)
		if pct := DiscountPercent(m, basic.List(cur, Monthly)); OffLabel(pct) != "60% OFF" {
			t.Errorf("Basic %s monthly = %d%% off, want 60%% OFF", cur, pct)
		}
	}
	ent, _ := FindPlan("enterprise")
	if !ent.ContactOnly || ent.Attendees() != 1000 || ent.StageSeats() != 100 {
		t.Errorf("Enterprise: contact %v, %d attendees, %d on stage; want contact, 1000, 100", ent.ContactOnly, ent.Attendees(), ent.StageSeats())
	}
	if f := ent.AllFeatures(); f[0] != "1,000+ attendees" || f[1] != "Up to 100 people on stage" {
		t.Errorf("Enterprise features start %q, %q", f[0], f[1])
	}
	var ids []types.Plan
	for _, p := range OnSale() {
		ids = append(ids, p.ID)
	}
	if len(ids) != 4 || ids[0] != types.PlanBasic || ids[3] != types.PlanEnterprise {
		t.Errorf("on sale = %v, want basic, professional, business, enterprise", ids)
	}
}

func TestYearlyListIsTheChargeOverOneFifth(t *testing.T) {
	for charge, want := range map[int64]int64{29_988_00: 1_49_940_00, 390_00: 1_950_00, 1: 5, 3: 15} {
		if got := YearlyList(charge); got != want {
			t.Errorf("YearlyList(%d) = %d, want %d", charge, got, want)
		}
	}
}

/* Starter is grandfathered: kept with its limits and price for the accounts on it, never
 * offered or sold to anyone else. */
func TestStarterIsGrandfathered(t *testing.T) {
	p, ok := FindPlan("starter")
	if !ok || !p.Retired {
		t.Fatal("starter should be kept, retired")
	}
	if p.Attendees() != 200 || p.StageSeats() != 3 {
		t.Errorf("starter caps = %d / %d, want 200 / 3", p.Attendees(), p.StageSeats())
	}
	if m, _ := p.Price(INR, Monthly); m != 3_999_00 {
		t.Errorf("starter INR monthly = %d, want ₹3,999", m)
	}
	for _, s := range OnSale() {
		if s.ID == types.PlanStarter {
			t.Error("starter is on sale")
		}
	}
	if _, err := NewQuote("starter", Monthly, INR, 18); !errors.Is(err, ErrRetired) {
		t.Errorf("a new buyer's starter quote: err %v, want ErrRetired", err)
	}
	q, err := NewQuoteFor("starter", Yearly, INR, 18, true)
	if err != nil || q.Subtotal != 39_948_00 {
		t.Errorf("an existing starter renewing yearly: %+v %v, want ₹39,948", q, err)
	}
	if !types.PlanStarter.Valid() {
		t.Error("starter must stay a valid plan id for its subscribers")
	}
}
