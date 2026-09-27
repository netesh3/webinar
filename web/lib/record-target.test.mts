/* Where a recording goes: availability, the main button, and the remembered choice.
 *
 * Run with `make test-web`.
 *
 * The failure worth pinning is starting a recording somewhere the host did not
 * pick — a remembered target that has since become unavailable, or junk in
 * storage — and a Stop that turns into a popup.
 */

import {
  initialSelection,
  parseRecordTarget,
  readRememberedTarget,
  recordAvailability,
  recordButtonTitle,
  recordingDetail,
  recordingTag,
  REMEMBER_KEY,
  resolveMainClick,
  writeRememberedTarget,
  type RecordCapabilities,
} from "./record-target.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

const all: RecordCapabilities = {
  cloudEnabled: true,
  isEgress: false,
  canComposite: true,
  canSaveLocally: true,
  canCaptureScreen: true,
};

// ------------------------------------------------------------ availability
{
  const a = recordAvailability(all);
  ok(a.cloud.available && a.local.available, "everything available");
  ok(a.cloud.reason === null && a.local.reason === null, "no reasons when available");
}
{
  const a = recordAvailability({ ...all, cloudEnabled: false });
  ok(!a.cloud.available, "cloud off on the instance → unavailable");
  ok(/server/i.test(a.cloud.reason ?? ""), "cloud reason names the server");
  ok(a.local.available, "local unaffected by instance storage");
}
{
  const a = recordAvailability({ ...all, canComposite: false });
  ok(!a.cloud.available, "client mode needs the browser to composite");
  const egress = recordAvailability({ ...all, canComposite: false, isEgress: true });
  ok(egress.cloud.available, "egress mode does not need the browser to composite");
}
{
  const a = recordAvailability({ ...all, canSaveLocally: false });
  ok(!a.local.available, "no File System Access → local unavailable");
  ok(/Chrome or Edge/.test(a.local.reason ?? ""), "local reason names the browsers that work");
  const b = recordAvailability({ ...all, canCaptureScreen: false });
  ok(!b.local.available, "no getDisplayMedia → local unavailable");
  ok(/capture/i.test(b.local.reason ?? ""), "capture reason wins when both are missing");
}

// ------------------------------------------------------------ main button
{
  const availability = recordAvailability(all);
  ok(
    resolveMainClick({ recording: true, remembered: "local", availability }).kind === "stop",
    "while recording the main button stops, even with a remembered choice",
  );
  ok(
    resolveMainClick({ recording: true, remembered: null, availability: recordAvailability({ ...all, cloudEnabled: false, canSaveLocally: false }) }).kind === "stop",
    "stop works even when nothing could be started now",
  );

  const ask = resolveMainClick({ recording: false, remembered: null, availability });
  ok(ask.kind === "choose", "nothing remembered → ask");
  ok(ask.kind === "choose" && ask.initial === "cloud", "ask pre-selects cloud first");

  const direct = resolveMainClick({ recording: false, remembered: "local", availability });
  ok(direct.kind === "start" && direct.target === "local", "remembered + available → start directly");

  const last = resolveMainClick({ recording: false, remembered: null, lastUsed: "local", availability });
  ok(last.kind === "choose" && last.initial === "local", "last used is pre-selected but still asked");
}
{
  const noLocal = recordAvailability({ ...all, canSaveLocally: false });
  const r = resolveMainClick({ recording: false, remembered: "local", availability: noLocal });
  ok(r.kind === "choose", "remembered target now unavailable → ask, never start elsewhere");
  ok(r.kind === "choose" && r.initial === "cloud", "…with the available one selected");

  const noCloud = recordAvailability({ ...all, cloudEnabled: false });
  const c = resolveMainClick({ recording: false, remembered: null, availability: noCloud });
  ok(c.kind === "choose" && c.initial === "local", "cloud off → local pre-selected");

  const none = recordAvailability({ ...all, cloudEnabled: false, canSaveLocally: false });
  const n = resolveMainClick({ recording: false, remembered: "cloud", availability: none });
  ok(n.kind === "choose" && n.initial === null, "nothing available → ask with nothing selected (reasons shown)");
  ok(initialSelection("cloud", none) === null, "no selection when nothing is available");
}

// ------------------------------------------------------------ storage
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}
{
  const s = memoryStorage();
  ok(readRememberedTarget(s) === null, "empty storage → not remembered");
  writeRememberedTarget(s, "local");
  ok(s.data.get(REMEMBER_KEY) === "local", "writes the target");
  ok(readRememberedTarget(s) === "local", "reads it back");
  writeRememberedTarget(s, null);
  ok(!s.data.has(REMEMBER_KEY), "null forgets");

  ok(readRememberedTarget(memoryStorage({ [REMEMBER_KEY]: "dropbox" })) === null, "junk → not remembered");
  ok(readRememberedTarget(null) === null, "no storage → not remembered");

  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  ok(readRememberedTarget(throwing) === null, "throwing storage reads as not remembered");
  let threw = false;
  try {
    writeRememberedTarget(throwing, "cloud");
  } catch {
    threw = true;
  }
  ok(!threw, "throwing storage never breaks Record");
}

// ------------------------------------------------------------ copy
{
  ok(parseRecordTarget("cloud") === "cloud" && parseRecordTarget(1) === null, "parse");
  const availability = recordAvailability(all);
  ok(recordButtonTitle(null, availability) === "Record — choose where to save", "idle title asks");
  ok(recordButtonTitle("cloud", availability) === "Record to the Cloud", "remembered cloud title");
  ok(recordButtonTitle("local", availability) === "Record on this computer", "remembered local title");
  ok(
    recordButtonTitle("local", recordAvailability({ ...all, canSaveLocally: false })) === "Record — choose where to save",
    "unavailable remembered target → asking title",
  );
  ok(recordingTag("local") === "Local" && recordingTag("cloud") === "Cloud", "tags");
  ok(recordingTag(null) === "Cloud", "someone else's server recording reads as Cloud");

  ok(recordingDetail("cloud", "12:38", null) === "Recording to the cloud · 12:38", "cloud detail");
  ok(recordingDetail("cloud", "12:38", "48 MB") === "Recording to the cloud · 12:38", "cloud detail never shows a size");
  ok(
    recordingDetail("local", "12:38", "48 MB") === "Recording to this computer · 12:38 · 48 MB",
    "local detail includes the file size",
  );
  ok(recordingDetail("local", "0:03", null) === "Recording to this computer · 0:03", "no size before the first chunk");
  ok(recordingDetail(null, null, null) === "Recording to the cloud", "unknown start time → no clock");
}

console.log(`record-target: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
