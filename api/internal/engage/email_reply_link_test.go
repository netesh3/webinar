package engage

import (
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
)

func TestReplyLinkUsesMessageIDOrRowID(t *testing.T) {
	smtp, stored := replyLink(store.HostEmail{ID: "row-1", MessageID: "outbox:abc"})
	if smtp != "<outbox:abc>" || stored != "<outbox:abc>" {
		t.Fatalf("message id: smtp %q stored %q", smtp, stored)
	}
	smtp, stored = replyLink(store.HostEmail{ID: "row-1", MessageID: "<already@x>"})
	if smtp != "<already@x>" || stored != "<already@x>" {
		t.Fatalf("bracketed id: smtp %q stored %q", smtp, stored)
	}
	smtp, stored = replyLink(store.HostEmail{ID: "row-1"})
	if smtp != "" || stored != "row-1" {
		t.Fatalf("no message id: smtp %q stored %q", smtp, stored)
	}
}
