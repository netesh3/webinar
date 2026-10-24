package aiwrite

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestParseReels(t *testing.T) {
	lines := []RecapLine{{AtSec: 0, Text: "a"}, {AtSec: 600, Text: "b"}}
	raw := `{"reels":[
	  {"title":"  \"Price by value\" ","hook":"","why":"Three beats.","moments":[{"startSec":10,"endSec":20},{"startSec":100,"endSec":100},{"startSec":900,"endSec":910}]},
	  {"title":"One moment only","hook":"x","why":"","moments":[{"startSec":10,"endSec":20},{"startSec":5000,"endSec":5010}]},
	  {"title":"Second","hook":"“Why most launches fail”","why":"","moments":[{"startSec":30,"endSec":40},{"startSec":50,"endSec":60}]},
	  {"title":"Third","hook":"h","why":"","moments":[{"startSec":30,"endSec":40},{"startSec":50,"endSec":60}]}]}`
	got, err := ParseReels(raw, lines, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("reels = %+v", got)
	}
	first := got[0]
	if first.Title != "Price by value" || first.Hook != "Price by value" || len(first.Moments) != 2 || first.Moments[1].EndSec != 110 {
		t.Fatalf("first = %+v", first)
	}
	if got[1].Title != "Second" || got[1].Hook != "Why most launches fail" {
		t.Fatalf("second = %+v", got[1])
	}
}

func TestParsePosts(t *testing.T) {
	raw := `{"posts":[
	  {"platform":"youtube","title":"How to price","text":"Learn it.","hashtags":["#pricing","Small Business","pricing"]},
	  {"platform":"tiktok","title":"No titles here","text":"  Price by value \r\n","hashtags":[]},
	  {"platform":"tiktok","title":"","text":"duplicate","hashtags":[]},
	  {"platform":"linkedin","title":"","text":"","hashtags":["x"]}]}`
	got, err := ParsePosts(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Platform != types.ClipPlatformTikTok || got[1].Platform != types.ClipPlatformYouTube {
		t.Fatalf("posts = %+v", got)
	}
	if got[0].Title != "" || got[0].Text != "Price by value" || len(got[0].Hashtags) != 0 {
		t.Fatalf("tiktok = %+v", got[0])
	}
	if strings.Join(got[1].Hashtags, ",") != "pricing,SmallBusiness" || got[1].Title != "How to price" {
		t.Fatalf("youtube = %+v", got[1])
	}
}

func TestPostsMessagesCarryTheVoice(t *testing.T) {
	msgs := PostsMessages(PostsInput{Topic: "Pricing", Title: "Value", Hook: "Stop", Said: []string{"Price by value."},
		DurationSec: 42, Reel: true, Voice: RepurposeVoice{Tone: "Warm and direct"}})
	user := msgs[1].Content
	for _, want := range []string{"Warm and direct", "Price by value.", "42 seconds", "reel", `"Stop"`} {
		if !strings.Contains(user, want) {
			t.Errorf("prompt lacks %q:\n%s", want, user)
		}
	}
}

func TestHook(t *testing.T) {
	if got := Hook(`  "Stop   charging by the hour" `); got != "Stop charging by the hour" {
		t.Fatalf("Hook = %q", got)
	}
	if got := Hook(strings.Repeat("a", 200)); len([]rune(got)) != types.ClipHookMaxRunes {
		t.Fatalf("long hook = %d runes", len([]rune(got)))
	}
}
