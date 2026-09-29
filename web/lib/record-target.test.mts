/* Where a recording goes: availability, the compact menu's copy and keys, and
 * clearing the choice an older build remembered.
 *
 * Run with `make test-web`.
 *
 * The failures worth pinning: offering a destination that cannot work (or
 * calling Cloud unavailable while the config is merely still loading), a menu
 * subline that grows into a paragraph, and junk storage breaking Record.
 */

import {
  anyTargetAvailable,
  clearLegacyRememberedTarget,
  initialMenuIndex,
  LEGACY_REMEMBER_KEY,
  menuSubline,
  menuTitle,
  moveMenuIndex,
  recordAvailability,
  recordingDetail,
  recordingTag,
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
  ok(!a.cloud.pending && !a.local.pending, "nothing pending once config is in");
}
{
  const a = recordAvailability({ ...all, cloudEnabled: false });
  ok(!a.cloud.available, "cloud off on the instance → unavailable");
  ok(/server/i.test(a.cloud.reason ?? ""), "cloud reason names the server");
  ok(a.local.available, "local unaffected by instance storage");
}
{
  const a = recordAvailability({ ...all, cloudEnabled: "checking" });
  ok(!a.cloud.available, "config loading → cloud cannot be started yet");
  ok(a.cloud.pending === true, "…but is pending, not unavailable");
  ok(a.cloud.reason === null, "…with no 'isn't turned on' reason");
  ok(a.local.available, "local does not wait for the config");

  const u = recordAvailability({ ...all, cloudEnabled: "unknown" });
  ok(!u.cloud.available && !u.cloud.pending, "config fetch failed → unavailable, not pending");
  ok(!/turned on/.test(u.cloud.reason ?? "") && /check/i.test(u.cloud.reason ?? ""), "…and says it couldn't check, not that it's off");
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
  ok(a.local.reason === "Needs Chrome or Edge on a computer.", "local reason is the short one");
  const b = recordAvailability({ ...all, canCaptureScreen: false });
  ok(!b.local.available, "no getDisplayMedia → local unavailable");
  ok(b.local.reason === a.local.reason, "same short reason either way");
}
{
  ok(anyTargetAvailable(recordAvailability(all)), "any: both");
  ok(
    !anyTargetAvailable(recordAvailability({ ...all, cloudEnabled: "checking", canSaveLocally: false })),
    "any: pending cloud does not count as available",
  );
}

// ------------------------------------------------------------ menu copy
{
  const a = recordAvailability(all);
  ok(menuTitle("cloud") === "Record to the Cloud" && menuTitle("local") === "Record on this Computer", "titles");
  ok(
    menuSubline("cloud", a.cloud, 30) === "Stored for 30 days. Download a copy if you need it longer.",
    "cloud subline with retention",
  );
  ok(menuSubline("cloud", a.cloud, 0) === "Saved to your recordings list.", "cloud subline, kept forever");
  ok(
    menuSubline("local", a.local, 30) === "Saved as a local file. Attendees aren't notified.",
    "local subline warns attendees aren't notified",
  );

  const off = recordAvailability({ ...all, cloudEnabled: false, canSaveLocally: false });
  ok(menuSubline("cloud", off.cloud, 30) === off.cloud.reason, "unavailable cloud → its reason");
  ok(menuSubline("local", off.local, 30) === "Needs Chrome or Edge on a computer.", "unavailable local → its reason");

  const pending = recordAvailability({ ...all, cloudEnabled: "checking" });
  ok(/checking/i.test(menuSubline("cloud", pending.cloud, 30)), "pending cloud → checking, not a reason");

  for (const [what, line] of [
    ["cloud", menuSubline("cloud", a.cloud, 30)],
    ["local", menuSubline("local", a.local, 30)],
    ["cloud off", menuSubline("cloud", off.cloud, 30)],
    ["local off", menuSubline("local", off.local, 30)],
    ["browser", menuSubline("cloud", recordAvailability({ ...all, canComposite: false }).cloud, 30)],
  ] as const) {
    ok(line.length <= 70, `${what} subline stays one short line (${line.length})`);
  }
}

// ------------------------------------------------------------ menu keys
{
  ok(initialMenuIndex([true, true]) === 0, "opens on the first item");
  ok(initialMenuIndex([false, true]) === 1, "skips a disabled first item");
  ok(initialMenuIndex([false, false]) === 0, "all disabled → still focus one so its reason is read");
  ok(initialMenuIndex([]) === -1, "empty menu → nothing");

  ok(moveMenuIndex(0, "ArrowDown", 2) === 1, "down");
  ok(moveMenuIndex(1, "ArrowDown", 2) === 0, "down wraps");
  ok(moveMenuIndex(0, "ArrowUp", 2) === 1, "up wraps");
  ok(moveMenuIndex(-1, "ArrowDown", 2) === 0 && moveMenuIndex(-1, "ArrowUp", 2) === 1, "from nothing");
  ok(moveMenuIndex(1, "Home", 3) === 0 && moveMenuIndex(0, "End", 3) === 2, "home / end");
  ok(moveMenuIndex(0, "ArrowDown", 0) === -1, "no items");
}

// ------------------------------------------------------------ legacy storage
{
  const data = new Map([[LEGACY_REMEMBER_KEY, "cloud"], ["other", "x"]]);
  clearLegacyRememberedTarget({ removeItem: (k: string) => void data.delete(k) });
  ok(!data.has(LEGACY_REMEMBER_KEY), "stale remembered choice is cleared");
  ok(data.get("other") === "x", "…and nothing else");

  let threw = false;
  try {
    clearLegacyRememberedTarget({
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    clearLegacyRememberedTarget(null);
  } catch {
    threw = true;
  }
  ok(!threw, "throwing or missing storage never breaks Record");
}

// ------------------------------------------------------------ pill copy
{
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
