package httpx

import (
	"testing"
	"time"
)

// The join path is rate limited, and an entire corporate audience arrives from
// one egress IP. Getting this wrong does not look like a rate limit — it looks
// like the webinar is broken for everyone in the building.
func TestRateLimiterAllowsUpToTheLimit(t *testing.T) {
	rl := NewRateLimiter(3, time.Minute)

	for i := 1; i <= 3; i++ {
		if ok, _ := rl.Allow("1.2.3.4"); !ok {
			t.Fatalf("request %d was rejected, but the limit is 3", i)
		}
	}
	ok, retryIn := rl.Allow("1.2.3.4")
	if ok {
		t.Error("the 4th request was allowed past a limit of 3")
	}
	if retryIn <= 0 {
		t.Error("a rejected request must report when to retry")
	}

	// Buckets are per key, so one noisy address cannot lock out another.
	if ok, _ := rl.Allow("5.6.7.8"); !ok {
		t.Error("a different IP was rejected because of another one's usage")
	}
}

// A misconfigured limit must not take an endpoint offline. config.validate()
// rejects a non-positive limit at boot; if one reaches the limiter anyway,
// failing open is recoverable and failing closed is not.
func TestRateLimiterWithNonPositiveLimitDoesNotBlock(t *testing.T) {
	for _, limit := range []int{0, -1} {
		rl := NewRateLimiter(limit, time.Minute)
		for i := 0; i < 5; i++ {
			if ok, _ := rl.Allow("1.2.3.4"); !ok {
				t.Fatalf("limit %d blocked request %d; a bad limit must not close the endpoint",
					limit, i+1)
			}
		}
	}
}

func TestRateLimiterWindowResets(t *testing.T) {
	rl := NewRateLimiter(1, 20*time.Millisecond)

	if ok, _ := rl.Allow("ip"); !ok {
		t.Fatal("first request rejected")
	}
	if ok, _ := rl.Allow("ip"); ok {
		t.Fatal("second request in the same window was allowed")
	}

	time.Sleep(30 * time.Millisecond)
	if ok, _ := rl.Allow("ip"); !ok {
		t.Error("the window did not reset")
	}
}
