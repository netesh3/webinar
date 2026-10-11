package api

import "testing"

func TestGmailAddress(t *testing.T) {
	yes := []string{"a@gmail.com", "A@Gmail.COM", "  a@gmail.com  ", "ada+tag@gmail.com"}
	no := []string{
		"",
		"gmail.com",
		"@gmail.com",
		"a@gmail.com.evil",
		"a@notgmail.com",
		"a@googlemail.com",
		"a@gmail.co",
		"a@gmail.com.",
	}
	for _, email := range yes {
		if !gmailAddress(email) {
			t.Errorf("%q should be gmail", email)
		}
	}
	for _, email := range no {
		if gmailAddress(email) {
			t.Errorf("%q should not be gmail", email)
		}
	}
}
