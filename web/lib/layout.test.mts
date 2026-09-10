/* Tests for the stage layout: sorting, filtering, paging, and the subscription
 * budget.
 *
 * Run with `make test-web`, which is `node --experimental-strip-types` — no test
 * runner and no build step, because the things worth testing here are four pure
 * functions and the alternative was adding a framework to a repo that has none.
 *
 * What is actually being checked, and why it needs checking rather than reading:
 *
 *   The 300-participant claim rests entirely on arithmetic that cannot be observed
 *   in a browser without 300 browsers. `paginate` bounds how many tiles exist and
 *   `applyBudget` bounds how many streams are subscribed; if either is wrong the
 *   failure mode is a dead tab at a scale nobody tests by hand.
 *
 *   `applyBudget` has one property that is easy to get wrong and impossible to
 *   notice: livekit-client hands the enable decision to whoever calls setEnabled
 *   FIRST and never gives it back to adaptiveStream. So a tile the viewer's filters
 *   removed has to be switched off explicitly. That is the last test here, and it
 *   is the one that would have caught the bug it describes.
 */

import {
  applyBudget,
  filterTiles,
  paginate,
  qualityFor,
  sortTiles,
  VideoQuality,
  MAX_TILE_CROP,
  tileFit,
  type LayoutPreferences,
  type Sortable,
} from "./layout.ts";
import { Track } from "livekit-client";

// ------------------------------------------------------------------ harness

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

function group(name: string, run: () => void): void {
  console.log(`\n${name}`);
  run();
}

/* A fake tile. `publication` records what the budget asked for, which is the only
 * way to test a function whose entire purpose is a side effect on the SFU. */
type Fake = Sortable & {
  calls: { enabled: boolean[]; quality: VideoQuality[] };
};

function tile(
  id: string,
  opts: {
    role?: "host" | "panelist" | "attendee";
    speaking?: boolean;
    local?: boolean;
    share?: boolean;
    /** Camera published but switched off — an avatar tile. */
    muted?: boolean;
    /** No publication at all, which is what a local track looks like here. */
    remote?: boolean;
  } = {},
): Fake {
  const calls = { enabled: [] as boolean[], quality: [] as VideoQuality[] };
  const publication =
    opts.remote === false
      ? // A local publication has neither method, so the budget must skip it.
        ({ isMuted: false, track: {} } as unknown as Sortable["publication"])
      : ({
          isMuted: opts.muted ?? false,
          track: opts.muted ? {} : {},
          setEnabled: (v: boolean) => calls.enabled.push(v),
          setVideoQuality: (q: VideoQuality) => calls.quality.push(q),
        } as unknown as Sortable["publication"]);

  return {
    key: id,
    source: opts.share ? Track.Source.ScreenShare : Track.Source.Camera,
    participant: {
      identity: id,
      isSpeaking: opts.speaking ?? false,
      isLocal: opts.local ?? false,
      metadata: JSON.stringify({ role: opts.role ?? "panelist" }),
    } as unknown as Sortable["participant"],
    publication,
    calls,
  };
}

const PREFS: LayoutPreferences = {
  hideNonVideo: false,
  onlySpeakers: false,
  pageSize: 25,
  currentPage: 0,
};

// ------------------------------------------------------------------- paging

group("paginate", () => {
  const many = Array.from(
    { length: 300 },
    (_, i) => `p${String(i).padStart(3, "0")}`,
  );

  for (const size of [16, 25, 49]) {
    const first = paginate(many, size, 0);
    eq(
      first.items.length,
      size,
      `page size ${size}: renders exactly ${size} tiles`,
    );
    eq(first.pages, Math.ceil(300 / size), `page size ${size}: page count`);
    eq(
      first.items.length + first.offscreen.length,
      300,
      `page size ${size}: every tile is either on the page or off it`,
    );
    // The property the whole feature rests on: 300 participants, one page of DOM.
    ok(
      first.items.length <= 49,
      `page size ${size}: never more than 49 tiles at once`,
    );
  }

  // Clamping. A page index outlives the list it indexed — somebody sitting on page
  // 12 when a webinar empties out must not be left staring at nothing.
  eq(
    paginate(many, 25, 99).page,
    11,
    "a page past the end clamps to the last page",
  );
  eq(paginate(many, 25, -5).page, 0, "a negative page clamps to the first");
  eq(paginate([], 25, 3).pages, 1, "an empty list still has one page");
  eq(paginate([], 25, 3).items.length, 0, "…with nothing on it");

  // No overlap and no gaps across every page.
  const seen = new Set<string>();
  const pages = paginate(many, 16, 0).pages;
  for (let i = 0; i < pages; i++) {
    for (const item of paginate(many, 16, i).items) {
      ok(!seen.has(item), `page ${i}: no tile appears on two pages`, item);
      seen.add(item);
    }
  }
  eq(seen.size, 300, "walking every page shows every tile exactly once");
});

// ------------------------------------------------------------------ sorting

group("sortTiles", () => {
  const tiles = [
    tile("zoe", { role: "attendee" }),
    tile("amy", { role: "panelist" }),
    tile("bob", { role: "host" }),
    tile("cat", { role: "panelist", speaking: true }),
    tile("dan", { role: "host", share: true }),
    tile("eve", { role: "panelist", muted: true }),
  ];

  const order = sortTiles(tiles, null).map((t) => t.key);
  eq(order[0], "dan", "a screen share sorts first");
  eq(order[1], "bob", "then the host");
  eq(order.at(-1), "zoe", "a promoted attendee sorts last");
  ok(
    order.indexOf("amy") < order.indexOf("eve"),
    "a live camera sorts above a muted one",
  );

  // The pin outranks every heuristic, including a live screen share.
  eq(
    sortTiles(tiles, "zoe")[0].key,
    "zoe",
    "a pinned tile sorts first, above a share",
  );

  /* Who is talking must not be in the order at all.
   *
   * `cat` is the speaking panelist in the fixture and sorts BELOW `bob` the host, purely on
   * role. This is the assertion that pins the fix: ranking speakers third made the stage
   * reshuffle several times a minute, which moved tiles under the viewer's cursor and
   * re-requested video layers for tiles that had merely said "yes". The border in
   * lib/speaker.ts shows who is talking instead, and it moves nothing.
   *
   * Checked as a property rather than as one expected list: flipping the speaking flag on
   * every tile in turn must leave the order byte-identical. A single hardcoded expectation
   * would still pass if speaking were re-introduced below role but above camera state. */
  ok(
    order.indexOf("bob") < order.indexOf("cat"),
    "the host outranks whoever is speaking",
  );
  const baseline = sortTiles(tiles, null).map((t) => t.key);
  /* The flag is mutated in place rather than spread into a copy: `participant` is a cast
   * partial of a real Participant, and spreading it produces an object the type no longer
   * accepts. Mutating a fixture is fine here — it is restored on each pass and read by
   * nothing else. */
  const setSpeaking = (t: Fake, speaking: boolean) => {
    (t.participant as unknown as { isSpeaking: boolean }).isSpeaking = speaking;
  };
  for (const target of tiles) {
    for (const t of tiles) setSpeaking(t, t === target);
    eq(
      sortTiles(tiles, null).map((t) => t.key),
      baseline,
      `the order is identical with ${target.key} speaking`,
    );
  }
  for (const t of tiles) setSpeaking(t, true);
  eq(
    sortTiles(tiles, null).map((t) => t.key),
    baseline,
    "…and identical with everybody speaking at once",
  );
  // Left as the fixture declared it, so nothing after this depends on the loop above.
  for (const t of tiles) setSpeaking(t, t.key === "cat");

  /* Your own camera goes last among equals, so it does not take the main stage.
   *
   * The host is role 0, and the host is usually also the local participant — so the focus tile
   * was the viewer's own face while the person talking sat in a thumbnail at the LOW simulcast
   * layer. Checked against a same-role pair, because that is the only case where the rule
   * decides anything: a local host still outranks a remote attendee. */
  const selfHost = tile("me", { local: true, role: "host" });
  const otherHost = tile("them", { role: "host" });
  eq(
    sortTiles([selfHost, otherHost], null).map((t) => t.key),
    ["them", "me"],
    "between two hosts, the remote one takes the stage",
  );
  eq(
    sortTiles([otherHost, selfHost], null).map((t) => t.key),
    ["them", "me"],
    "…whichever order they arrived in",
  );
  // But not at the cost of the role order: a local host still outranks a remote attendee.
  eq(
    sortTiles([tile("guest", { role: "attendee" }), selfHost], null).map(
      (t) => t.key,
    ),
    ["me", "guest"],
    "being local does not push a host below an attendee",
  );
  // And an attendee, who publishes nothing, has no local tile — so their order is untouched.
  eq(
    sortTiles([tile("panel", { role: "panelist" }), otherHost], null).map(
      (t) => t.key,
    ),
    ["them", "panel"],
    "a viewer with no camera of their own still sees the host first",
  );
  // A pin still wins, and so does a share.
  eq(
    sortTiles([selfHost, otherHost], "me")[0].key,
    "me",
    "pinning yourself still works",
  );

  /* Stability, tested where it actually matters.
   *
   * The first version of this compared the fixture above against its own reverse
   * and passed even with the identity tiebreak deleted — because no two tiles in it
   * were equal on every earlier key, so the tiebreak was never reached. These four
   * are identical in every respect except their identity, which is the only case
   * that exercises it. Without it the grid reshuffles on every audio-level update
   * and nothing can be clicked. */
  const twins = [tile("d"), tile("b"), tile("a"), tile("c")];
  eq(
    sortTiles(twins, null).map((t) => t.key),
    ["a", "b", "c", "d"],
    "tiles equal on every heuristic fall back to identity order",
  );
  eq(
    sortTiles([...twins].reverse(), null).map((t) => t.key),
    ["a", "b", "c", "d"],
    "…whichever order they arrived in",
  );

  const a = sortTiles(tiles, null).map((t) => t.key);
  const b = sortTiles([...tiles].reverse(), null).map((t) => t.key);
  eq(a, b, "and the ranked fixture is order-independent too");
});

// ---------------------------------------------------------------- filtering

group("filterTiles", () => {
  const tiles = [
    tile("me", { local: true, muted: true, role: "host" }),
    tile("live", { role: "panelist" }),
    tile("dark", { role: "panelist", muted: true }),
    tile("guest", { role: "attendee" }),
    tile("deck", { role: "host", share: true }),
  ];

  const hidden = filterTiles(tiles, { ...PREFS, hideNonVideo: true }).map(
    (t) => t.key,
  );
  ok(!hidden.includes("dark"), "hideNonVideo drops a camera that is off");
  ok(hidden.includes("me"), "…but never your own tile, muted or not");
  ok(hidden.includes("deck"), "…and never a screen share");

  const speakers = filterTiles(tiles, { ...PREFS, onlySpeakers: true }).map(
    (t) => t.key,
  );
  ok(!speakers.includes("guest"), "onlySpeakers drops a promoted attendee");
  ok(speakers.includes("live"), "…keeps panelists");
  ok(speakers.includes("deck"), "…and keeps a share whoever owns it");

  eq(filterTiles(tiles, PREFS).length, 5, "no filters means no filtering");
});

// ------------------------------------------------------------------- budget

group("qualityFor", () => {
  eq(qualityFor(1), VideoQuality.HIGH, "one tile gets the top layer");
  eq(qualityFor(2), VideoQuality.HIGH, "two tiles still do");
  eq(qualityFor(9), VideoQuality.MEDIUM, "nine tiles drop to the middle layer");
  eq(qualityFor(25), VideoQuality.LOW, "a full grid asks for the low layer");
  eq(qualityFor(300), VideoQuality.LOW, "and so does an absurd one");
});

group("applyBudget", () => {
  const onPage = tile("onpage");
  const offPage = tile("offpage");
  const share = tile("deck", { share: true });
  const localTile = tile("me", { local: true, remote: false });

  const wanted = new Map([[onPage.key, VideoQuality.LOW]]);
  applyBudget([onPage, offPage, share, localTile], wanted);

  eq(onPage.calls.enabled, [true], "a tile on the page is enabled");
  eq(
    onPage.calls.quality,
    [VideoQuality.LOW],
    "…at the layer the layout asked for",
  );
  eq(offPage.calls.enabled, [false], "a tile off the page is switched off");
  eq(
    offPage.calls.quality,
    [],
    "…and is not asked for a layer it will not receive",
  );
  eq(share.calls.enabled, [], "a screen share off the page is left subscribed");

  // The local publication has neither method; reaching for one would throw.
  ok(true, "a local publication is skipped without throwing");

  /* The property that matters most, and the one a browser cannot show you.
   *
   * `isEnabled` in livekit-client is
   *   requestedDisabled !== undefined ? !requestedDisabled : visible
   * so the first setEnabled call takes the decision away from adaptiveStream for
   * good. A tile the viewer's filters removed is therefore invisible to
   * adaptiveStream AND no longer governed by it — it has to be switched off here or
   * it downloads for the rest of the session with nothing rendering it.
   *
   * This is why the stage hands applyBudget every tile rather than just the page. */
  const all = [tile("a"), tile("b"), tile("c"), tile("d")];
  const filtered = filterTiles(all, { ...PREFS, hideNonVideo: true });
  const paged = paginate(sortTiles(filtered, null), 2, 0);
  applyBudget(all, new Map(paged.items.map((t) => [t.key, VideoQuality.LOW])));

  const disabled = all
    .filter((t) => t.calls.enabled.at(-1) === false)
    .map((t) => t.key);
  const enabled = all
    .filter((t) => t.calls.enabled.at(-1) === true)
    .map((t) => t.key);
  eq(enabled.length, 2, "only the current page is subscribed");
  eq(disabled.length, 2, "everything else is switched off");
  eq(
    [...enabled, ...disabled].sort(),
    ["a", "b", "c", "d"],
    "every tile is accounted for — none left to adaptiveStream after the handover",
  );

  // And at the scale the feature is for.
  const crowd = Array.from({ length: 300 }, (_, i) =>
    tile(`c${String(i).padStart(3, "0")}`),
  );
  const page = paginate(sortTiles(crowd, null), 25, 4);
  applyBudget(
    crowd,
    new Map(page.items.map((t) => [t.key, qualityFor(page.items.length)])),
  );
  eq(
    crowd.filter((t) => t.calls.enabled.at(-1) === true).length,
    25,
    "300 participants, 25 subscribed",
  );
  eq(
    crowd.filter((t) => t.calls.enabled.at(-1) === false).length,
    275,
    "…and 275 explicitly switched off",
  );
  ok(
    crowd.every((t) => t.calls.quality.every((q) => q === VideoQuality.LOW)),
    "every subscribed tile in a full grid asks for the low layer",
  );
});

// -------------------------------------------------------------------- report

/* ---------------------------------------------------------------- tileFit
 *
 * The reported symptom: a host's own camera looked soft and over-zoomed in speaker view. The
 * cause was not the network — a local preview never leaves the machine — it was `object-fit:
 * cover` against a tile the layout had made 2.6:1 while the camera was 16:9, so a third of the
 * frame height was cropped and the rest magnified across the full width.
 *
 * Nothing about that is catchable in a browser by whoever changes the layout: it depends on the
 * window's proportions, and on a normally-shaped window it does not happen at all.
 */
console.log("\ntileFit");
{
  const CAMERA = 16 / 9;

  // The exact case from the report: full-width speaker tile, short window.
  eq(
    tileFit(2.6, CAMERA),
    "contain",
    "an extreme speaker tile letterboxes instead of cropping",
  );

  // The common case, and the one that must not change: a tile shaped like the camera.
  eq(tileFit(CAMERA, CAMERA), "cover", "a matching tile still fills");
  eq(tileFit(1.7, CAMERA), "cover", "a near-matching tile still fills");

  // A 4:3 tile crops a quarter off the sides and is still better cropped than letterboxed —
  // this is the judgement the threshold encodes, so it is worth stating.
  eq(
    tileFit(4 / 3, CAMERA),
    "cover",
    "a 4:3 tile crops rather than letterboxing",
  );

  // Mismatch in the other direction: a tall, narrow tile — a phone in portrait.
  eq(
    tileFit(0.5, CAMERA),
    "contain",
    "a portrait tile letterboxes a landscape camera",
  );

  // Degenerate inputs keep the old behaviour rather than flipping the fit mid-layout, which
  // the viewer would see as the video jumping.
  eq(tileFit(0, CAMERA), "cover", "a zero-height box does not change the fit");
  eq(
    tileFit(CAMERA, 0),
    "cover",
    "an unknown source aspect does not change the fit",
  );
  eq(tileFit(Number.NaN, CAMERA), "cover", "NaN does not change the fit");

  // Symmetric: the decision depends on how far apart the two are, not which is larger.
  eq(tileFit(1 / 2.6, 1 / CAMERA), "contain", "the rule is symmetric");

  // And the threshold is the thing being tuned, so pin where it bites.
  ok(
    MAX_TILE_CROP > 0.25 && MAX_TILE_CROP < 0.4,
    "the crop allowance stays between a 4:3 tile and an absurd one",
    String(MAX_TILE_CROP),
  );
  // Just inside and just outside, computed from the constant rather than hardcoded.
  const switchover = CAMERA / (1 - MAX_TILE_CROP);
  eq(
    tileFit(switchover * 0.99, CAMERA),
    "cover",
    "just inside the allowance fills",
  );
  eq(
    tileFit(switchover * 1.01, CAMERA),
    "contain",
    "just outside it letterboxes",
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
