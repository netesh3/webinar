/* Tests for the chat preview card: what counts as new, and how a burst collapses.
 *
 * Run with `make test-web`.
 *
 * These exist because the case that matters is a case nobody can produce by hand. A
 * single message arriving while the panel is shut is easy to check in a browser; four
 * people typing at once, a reconnect merging thirty lines of history into the middle of
 * the conversation, and your own message coming back off the wire are not — and each of
 * those, got wrong, is a wall of cards over somebody's live video or a notification about
 * something they said themselves.
 */

import {
  coalesce,
  freshMessages,
  previewText,
  PREVIEW_CHARS,
  type ChatPreview,
} from "./chat-notify.ts";
import type { ChatMessage } from "./realtime.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

/** When this browser is pretending to have joined. Messages stamped before it are
 *  history, whether they arrive on the wire or in a backlog. */
const JOINED = 1_700_000_000_000;

let seq = 0;

function message(
  id: string,
  name: string,
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  seq++;
  return {
    kind: "chat",
    id,
    from: { identity: `att_${name}`, name, role: "attendee" },
    destination: "everyone",
    text,
    at: JOINED + seq * 1000,
    seq,
    ...extra,
  };
}

console.log("\npreviewText");

{
  eq(previewText(message("a", "Ana", "Hello")), "Hello", "a short message is shown whole");

  /* A pasted paragraph. Left as-is this made the card as tall as the message, which is
   * the one thing a notification over live video must not do. */
  eq(
    previewText(message("b", "Ana", "line one\n\nline two\t  line three")),
    "line one line two line three",
    "newlines and runs of whitespace collapse to single spaces",
  );

  const long = "x".repeat(PREVIEW_CHARS + 40);
  const cut = previewText(message("c", "Ana", long));
  eq(cut.length, PREVIEW_CHARS, "a long message is cut to the preview length");
  ok(cut.endsWith("…"), "…and says it was cut", cut.slice(-4));

  /* An image with no caption. `text` is empty for these — see the decode path in
   * realtime.ts, where a media message is valid without any — so without this the card
   * would announce a sender and nothing else. */
  eq(
    previewText(
      message("d", "Ana", "", {
        media: { url: "/api/x.png", mime: "image/png", width: 10, height: 10 },
      }),
    ),
    "Sent an image",
    "an image with no caption still says something",
  );

  eq(
    previewText(message("e", "Ana", "   ")),
    "",
    "a message with nothing in it produces no preview",
  );
}

console.log("\nfreshMessages");

const ME = "att_me";

{
  const chat = [
    message("m1", "Ana", "one"),
    message("m2", "Bo", "two"),
  ];
  eq(
    freshMessages(chat, new Set(), ME, JOINED).map((m) => m.id),
    ["m1", "m2"],
    "everything unaccounted for is new",
  );
  eq(
    freshMessages(chat, new Set(["m1"]), ME, JOINED).map((m) => m.id),
    ["m2"],
    "…and anything already notified is not new again",
  );
  eq(
    freshMessages(chat, new Set(["m1", "m2"]), ME, JOINED),
    [],
    "a re-render with nothing new produces nothing",
  );
}

/* Joining a conversation already in progress.
 *
 * The backlog fetch resolves after the room has mounted, so these messages appear as
 * arrivals — twenty of them at once on a busy webinar. Announcing somebody's arrival to
 * them with a card about a conversation they were not in is the wrong first impression,
 * and it is why `since` exists alongside the id set. */
{
  const history = [
    { ...message("h1", "Ana", "said before you got here"), at: JOINED - 60_000 },
    { ...message("h2", "Bo", "also before you got here"), at: JOINED - 30_000 },
  ];
  const live = message("live", "Cy", "said after you arrived");
  eq(
    freshMessages([...history, live], new Set(), ME, JOINED).map((m) => m.id),
    ["live"],
    "a backlog fetched after joining is history, not a burst of arrivals",
  );
}

/* Your own message, which reaches the conversation twice over: applied optimistically
 * when you are a publisher, and returned by the relay when you are an attendee. Being
 * notified about your own sentence is the most obviously broken thing this could do. */
{
  const mine = message("mine", "Me", "hello");
  mine.from.identity = ME;
  eq(
    freshMessages([mine, message("theirs", "Ana", "hi")], new Set(), ME, JOINED).map(
      (m) => m.id,
    ),
    ["theirs"],
    "your own messages are never news to you",
  );
}

/* The reconnect. `mergeChat` sorts a fetched backlog into the conversation by seq, so
 * history lands BEFORE messages that are already on screen and accounted for. A cursor
 * that was a length or an index would read the whole backlog as new arrivals — and this
 * happens exactly when somebody's connection has just dropped. */
{
  const live = message("live", "Ana", "said while connected");
  const backlog = [
    message("old1", "Bo", "before the drop"),
    message("old2", "Cy", "also before the drop"),
  ];
  const merged = [...backlog, live];
  eq(
    freshMessages(merged, new Set(["live", "old1", "old2"]), ME, JOINED),
    [],
    "a backlog whose messages are all accounted for announces nothing",
  );
  eq(
    freshMessages(merged, new Set(["live"]), ME, JOINED).map((m) => m.id),
    ["old1", "old2"],
    "…and one that genuinely contains unseen messages is judged by id, not by position",
  );
}

console.log("\ncoalesce");

{
  const one = coalesce(null, [message("m1", "Ana", "just the one")]);
  eq(
    one,
    { anchorId: "m1", sender: "Ana", text: "just the one", count: 1 },
    "a single message names its sender",
  );
}

/* The burst this whole function exists for: four arrivals must be one card, not four. */
{
  const burst = coalesce(null, [
    message("m1", "Ana", "first"),
    message("m2", "Bo", "second"),
    message("m3", "Cy", "third"),
    message("m4", "Di", "fourth"),
  ]);
  eq(burst?.count, 4, "a burst is counted, not stacked");
  eq(burst?.text, "fourth", "the card shows the latest message");
  eq(burst?.sender, "Di", "…and the latest sender");
  /* The anchor stays on the FIRST of the run. Clicking "4 new messages" is an
   * invitation to read those four; the newest is where the panel scrolls by itself. */
  eq(burst?.anchorId, "m1", "the click still lands on the oldest of the run");
}

// Arrivals in separate ticks — which is what actually happens — accumulate the same way.
{
  let preview: ChatPreview | null = null;
  preview = coalesce(preview, [message("m1", "Ana", "first")]);
  preview = coalesce(preview, [message("m2", "Bo", "second")]);
  preview = coalesce(preview, [message("m3", "Cy", "third")]);
  eq(
    preview,
    { anchorId: "m1", sender: "Cy", text: "third", count: 3 },
    "messages arriving one render apart coalesce like messages arriving together",
  );
}

{
  const existing: ChatPreview = { anchorId: "m1", sender: "Ana", text: "first", count: 1 };
  eq(
    coalesce(existing, []),
    existing,
    "a render with no arrivals leaves the card exactly as it was",
  );
  ok(
    coalesce(existing, []) === existing,
    "…and returns the same object, so nothing re-renders or restarts its timer",
  );
  eq(
    coalesce(null, []),
    null,
    "no card and no arrivals stays no card",
  );
}

/* A message with no preview text — an empty body and no image — must not bump the count.
 * "2 new messages" with one of them invisible is a card that sends somebody looking for
 * something that is not there. */
{
  const withEmpty = coalesce(null, [
    message("m1", "Ana", "real"),
    message("m2", "Bo", "  "),
  ]);
  eq(withEmpty?.count, 1, "a message with nothing to show does not inflate the count");
  eq(withEmpty?.text, "real", "…and does not replace the text either");
  eq(
    coalesce(null, [message("m1", "Ana", "")]),
    null,
    "a run of nothing but empty messages produces no card at all",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
