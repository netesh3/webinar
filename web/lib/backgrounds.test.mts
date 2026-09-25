/* Tests for the virtual-background catalogue.
 *
 * Run with `make test-web`.
 *
 * Preferences are persisted as JSON, so an old `{ mode: "image", id: "aurora" }`
 * still sits in some browsers. The compositor must never see an id it cannot
 * load — that is a black frame with no UI to explain it.
 */

import {
  asBackgroundChoice,
  describeBackground,
  describeBackgroundError,
  isBackgroundAttachAbort,
  VIRTUAL_BACKGROUNDS,
} from "./backgrounds.ts";

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

console.log("\nVIRTUAL_BACKGROUNDS");

{
  ok(VIRTUAL_BACKGROUNDS.length >= 1, "there is at least one still to pick");
  const ids = new Set(VIRTUAL_BACKGROUNDS.map((b) => b.id));
  ok(ids.size === VIRTUAL_BACKGROUNDS.length, "ids are unique");
  for (const b of VIRTUAL_BACKGROUNDS) {
    ok(b.src.startsWith("/backgrounds/"), `${b.id} is served from this origin`);
  }
}

console.log("\nasBackgroundChoice");

{
  eq(asBackgroundChoice({ mode: "none" }), { mode: "none" }, "off stays off");
  eq(asBackgroundChoice({ mode: "blur" }), { mode: "blur" }, "blur stays blur");
  eq(
    asBackgroundChoice({ mode: "image", id: "office" }),
    { mode: "image", id: "office" },
    "a known still is kept",
  );
  eq(
    asBackgroundChoice({ mode: "image", id: "aurora" }),
    { mode: "blur" },
    "an old still that no longer ships becomes blur, not off",
  );
  eq(
    asBackgroundChoice({ mode: "image" }),
    { mode: "blur" },
    "image without an id also becomes blur",
  );
  eq(
    asBackgroundChoice({ mode: "solid", color: "#000" }),
    { mode: "blur" },
    "a retired mode that hid the room still hides it",
  );
  eq(asBackgroundChoice(undefined), { mode: "none" }, "missing prefs are off");
  eq(asBackgroundChoice(null), { mode: "none" }, "null prefs are off");
}

console.log("\ndescribeBackground");

{
  eq(describeBackground({ mode: "none" }), "Off", "off");
  eq(describeBackground({ mode: "blur" }), "Blurred", "blur");
  eq(
    describeBackground({ mode: "image", id: "office" }),
    "Office",
    "a still uses its label",
  );
}

console.log("\ndescribeBackgroundError");

{
  const GPU =
    "Couldn't start the background: your browser ran out of graphics capacity. Close a few tabs and try again.";

  // The report that prompted it, verbatim from the pre-join screen.
  eq(
    describeBackgroundError(
      new Error(
        "Unable to initialize EGL context. Error querying for GL extensions. INTERNAL: Service kGpuService, a required service, failed to initialize.",
      ),
    ),
    GPU,
    "MediaPipe's GPU start-up failure is a graphics-capacity sentence",
  );
  eq(
    describeBackgroundError(
      // CONTEXT_LOST in lib/segmenter.ts, wrapped as createSegmenter wraps it.
      new Error(
        "your browser ran out of graphics capacity — too many open tabs are using it. Close a few and try again.",
        { cause: new Error("emscripten threw") },
      ),
    ),
    GPU,
    "our own context-lost error reads the same",
  );
  eq(
    describeBackgroundError(
      new Error("the segmentation model did not load", {
        cause: new TypeError("Cannot read properties of null (reading 'alpha')"),
      }),
    ),
    GPU,
    "a context loss is found in the cause, not only the message",
  );
  eq(
    describeBackgroundError(new TypeError("Failed to fetch")),
    "Couldn't download the background effect. Check your connection and try again.",
    "a failed download says to check the connection",
  );
  eq(
    describeBackgroundError(
      new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/x.js"),
    ),
    "Couldn't download the background effect. Check your connection and try again.",
    "a failed chunk load is a download too",
  );
  eq(
    describeBackgroundError(new Error("background image failed to load: /backgrounds/office.jpg")),
    "Couldn't load that background image. Try again or pick another one.",
    "a still that did not load says to pick another",
  );
  eq(
    describeBackgroundError(new Error("callbacks.shift(...) is not a function")),
    "Couldn't start the background. Try again, or reload the page if it keeps happening.",
    "anything else is a sentence, never the raw message",
  );
  eq(
    describeBackgroundError(new Error("WebGL2 is not available"), true),
    "Couldn't adjust your video: your browser ran out of graphics capacity. Close a few tabs and try again.",
    "low light on its own does not mention a background",
  );
  eq(
    describeBackgroundError(new TypeError("NetworkError when attempting to fetch resource."), true),
    "Couldn't load the video adjustment. Check your connection and try again.",
    "low light on its own has its own download sentence",
  );
  eq(
    describeBackgroundError("kGpuService failed"),
    GPU,
    "a thrown string is read like a message",
  );
  eq(
    describeBackgroundError(undefined),
    "Couldn't start the background. Try again, or reload the page if it keeps happening.",
    "nothing at all still gets a sentence",
  );
  const loop: { message: string; cause?: unknown } = { message: "odd" };
  loop.cause = loop;
  eq(
    describeBackgroundError(loop),
    "Couldn't start the background. Try again, or reload the page if it keeps happening.",
    "a cause chain that loops does not hang",
  );
  for (const err of [
    new Error("Unable to initialize EGL context. Error querying for GL extensions. INTERNAL: Service kGpuService, a required service, failed to initialize."),
    new Error("x".repeat(400)),
  ]) {
    const said = describeBackgroundError(err);
    ok(
      !said.includes("kGpuService") && !said.includes("xxxx"),
      "the raw message never reaches the screen",
      said,
    );
  }
}

console.log("\nisBackgroundAttachAbort");

{
  ok(
    isBackgroundAttachAbort(
      new Error("Failed to construct 'MediaStreamTrackProcessor': Input track cannot be ended"),
    ),
    "LiveKit's stopped-camera sentence is an attach abort, not a Retry",
  );
  ok(
    isBackgroundAttachAbort(new Error("anything"), true),
    "an ended track is an attach abort even without that sentence",
  );
  ok(
    !isBackgroundAttachAbort(new Error("callbacks.shift(...) is not a function")),
    "a real MediaPipe failure is not treated as an attach abort",
  );
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
