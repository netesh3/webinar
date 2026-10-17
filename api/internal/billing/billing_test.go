package billing

import "testing"

func TestQuoteAddsGSTToINROnly(t *testing.T) {
	q, err := NewQuote("business", Monthly, INR, 18)
	if err != nil {
		t.Fatal(err)
	}
	if q.Subtotal != 9_999_00 || q.Tax != 1_799_82 || q.Total != 11_798_82 {
		t.Fatalf("INR monthly business: %+v", q)
	}
	q, _ = NewQuote("business", Yearly, USD, 18)
	if q.Subtotal != 1_990_00 || q.Tax != 0 || q.Total != 1_990_00 {
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
			if l := p.List(cur, Yearly); l%(12*100) != 0 || (l/12/100)%10 != 9 {
				t.Errorf("%s INR yearly list = %d: want 12 × a ₹…9 month", p.Name, l)
			}
		}
	}
	if y, _ := Plans[0].Price(INR, Yearly); y != 39_948_00 {
		t.Errorf("Professional INR yearly = %d, want ₹39,948", y)
	}
}
