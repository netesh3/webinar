package types

import (
	"slices"
	"strings"
)

/* Reserved inbox local parts (29 Oct 2026).
 *
 * Hosts pick the local part of their reply address, local@webinarliv.com. Cloudflare
 * routing rules send some of these addresses to the company's own Gmail, and those rules
 * win over the catch-all that feeds a host's inbox. So a host who claimed security@ would
 * never see a message sent to it, and one who claimed billing@ would look like the company.
 * Neither EnsureInbox nor RenameInbox hands out a name on this list. Rows that already
 * hold one are left alone and logged at boot (store.ReservedInboxHolders).
 *
 * The list is wider than the addresses routed today, so a new company address does not
 * first have to be taken back from a host. */
var ReservedInboxLocals = map[string]struct{}{
	"support": {}, "invite": {}, "security": {}, "hello": {}, "billing": {},
	"privacy": {}, "legal": {}, "abuse": {}, "partners": {}, "noreply": {},
	"no-reply": {}, "admin": {}, "administrator": {}, "postmaster": {}, "hostmaster": {},
	"webmaster": {}, "root": {}, "info": {}, "sales": {}, "help": {},
	"team": {}, "contact": {}, "careers": {}, "jobs": {}, "press": {},
	"marketing": {}, "accounts": {}, "account": {}, "payments": {}, "finance": {},
	"compliance": {}, "dpo": {}, "grievance": {}, "mail": {}, "email": {},
	"inbox": {}, "www": {}, "api": {}, "app": {}, "cdn": {},
	"downloads": {}, "status": {}, "zoom-review": {}, "demo": {},
}

// InboxLocalReserved reports whether local is on ReservedInboxLocals, ignoring case and
// surrounding space.
func InboxLocalReserved(local string) bool {
	_, ok := ReservedInboxLocals[strings.ToLower(strings.TrimSpace(local))]
	return ok
}

// ReservedInboxLocalList is the list in a stable order, for a SQL ANY($1) parameter.
func ReservedInboxLocalList() []string {
	out := make([]string, 0, len(ReservedInboxLocals))
	for k := range ReservedInboxLocals {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
