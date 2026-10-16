package api_test

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/types"
)

// Finished bot conversations go 30 days after they ended; live ones and recent ones
// stay, and the bot's per-state totals do not drop when the rows do.
func TestFinishedBotSessionsArePrunedWithoutLosingTotals(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Bot retention")
	connectWhatsApp(t, h)
	contact := registerOptedIn(t, h, wb.ID)
	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Desk", Trigger: types.BotAnyMessage, Entry: "hi", Active: true,
		Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello.", "")},
	})
	ctx := t.Context()
	db := h.store.Pool()

	if _, err := db.Exec(ctx, `
		INSERT INTO crm_bot_sessions (bot_id, contact_id, state, updated_at) VALUES
		  ($1::uuid, $2::uuid, 'done',    now() - interval '40 days'),
		  ($1::uuid, $2::uuid, 'stopped', now() - interval '40 days'),
		  ($1::uuid, $2::uuid, 'handoff', now() - interval '5 days'),
		  ($1::uuid, $2::uuid, 'waiting', now() - interval '40 days')`,
		bot.Bot.ID, contact.ID); err != nil {
		t.Fatal(err)
	}
	want := types.CRMBotStats{Waiting: 1, Done: 1, HandedOff: 1, Stopped: 1}
	if got := readBot(t, h, bot.Bot.ID).Bot.Stats; got != want {
		t.Fatalf("stats before = %+v, want %+v", got, want)
	}

	store := crmstore.New(h.store)
	cutoff := time.Now().Add(-crmstore.BotSessionRetention)
	n, err := store.PruneFinishedBotSessions(ctx, cutoff, 1)
	if err != nil || n != 2 {
		t.Fatalf("pruned = %d, %v; want the two old finished sessions", n, err)
	}
	after := readBot(t, h, bot.Bot.ID)
	if after.Bot.Stats != want {
		t.Fatalf("stats after = %+v, want unchanged %+v", after.Bot.Stats, want)
	}
	if len(after.Sessions) != 2 {
		t.Fatalf("sessions after = %+v, want the live one and the recent handoff", after.Sessions)
	}

	// Nothing left to prune, and running again does not count anything twice.
	if n, err := store.PruneFinishedBotSessions(ctx, cutoff, 1); err != nil || n != 0 {
		t.Fatalf("second prune = %d, %v", n, err)
	}
	if got := readBot(t, h, bot.Bot.ID).Bot.Stats; got != want {
		t.Fatalf("stats after second prune = %+v, want %+v", got, want)
	}
}
