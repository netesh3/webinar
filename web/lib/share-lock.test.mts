/* Tests for "one screen share at a time": lib/share-lock.ts.
 *
 * Run with `make test-web` (node --experimental-strip-types, no runner — the same
 * harness as layout.test.mts).
 *
 * The rule has to come out the same in every browser and on the server, so the cases
 * worth pinning down are the orderings: who wins when a host takes over, when two
 * panelists race, when a stamp is missing, and what each person's own browser does
 * about it.
 */

import {
  isPrivileged,
  pickShare,
  shareGate,
  shareStartedAt,
  shouldYield,
  yieldMessage,
  type OtherShare,
  type ShareCandidate,
} from "./share-lock.ts";

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

const share = (
  identity: string,
  startedAt: number | null,
  opts: { privileged?: boolean; muted?: boolean } = {},
): ShareCandidate => ({
  identity,
  startedAt,
  privileged: opts.privileged ?? false,
  muted: opts.muted ?? false,
});

const winner = (shares: ShareCandidate[]) => pickShare(shares)?.identity ?? null;

group("pickShare: who is on the stage", () => {
  eq(winner([]), null, "nobody sharing");
  eq(winner([share("pan_a", 100)]), "pan_a", "one share is the share");
  eq(
    winner([share("pan_a", 100), share("pan_b", 200)]),
    "pan_a",
    "two panelists: the first one keeps the stage",
  );
  eq(
    winner([share("pan_a", 100), share("host", 200, { privileged: true })]),
    "host",
    "a host share that came later takes over",
  );
  eq(
    winner([share("host", 100, { privileged: true }), share("pan_a", 200)]),
    "host",
    "a panelist share after the host's does not take over",
  );
  eq(
    winner([
      share("host", 100, { privileged: true }),
      share("cohost", 200, { privileged: true }),
    ]),
    "cohost",
    "host and co-host: the newest takes over",
  );
  eq(
    winner([share("pan_a", 100), share("pan_b", null)]),
    "pan_a",
    "an undated panelist share is newest, so it does not displace the first",
  );
  eq(
    winner([share("host", 100, { privileged: true }), share("cohost", null, { privileged: true })]),
    "cohost",
    "an undated host share is newest, so it takes over",
  );
  eq(
    winner([share("pan_b", 100), share("pan_a", 100)]),
    "pan_a",
    "a tie is broken by identity, the same way everywhere",
  );
  eq(
    winner([share("pan_a", 100, { muted: true }), share("pan_b", 200)]),
    "pan_b",
    "a muted share (the server stopped it) is not presenting",
  );
  eq(
    winner([share("host", 300, { privileged: true, muted: true }), share("pan_a", 100)]),
    "pan_a",
    "a muted host share is not presenting either",
  );
});

group("shareGate: what the Share button does", () => {
  eq(shareGate(false, null), { kind: "start" }, "panelist, nobody sharing: share");
  eq(shareGate(true, null), { kind: "start" }, "host, nobody sharing: share");
  eq(
    shareGate(true, { name: "Amlesh" }),
    { kind: "takeover", sharer: "Amlesh" },
    "host while somebody shares: offer a takeover",
  );
  eq(
    shareGate(false, { name: "Amlesh" }),
    { kind: "blocked", sharer: "Amlesh" },
    "panelist while somebody shares: blocked",
  );
});

const other = (
  name: string,
  opts: { privileged?: boolean; muted?: boolean; presentAtStart?: boolean } = {},
): OtherShare => ({
  identity: name.toLowerCase(),
  name,
  privileged: opts.privileged ?? false,
  muted: opts.muted ?? false,
  presentAtStart: opts.presentAtStart ?? false,
});

const host = { privileged: true, mutedByServer: false };
const panelist = { privileged: false, mutedByServer: false };

group("shouldYield: does my own share stop", () => {
  eq(shouldYield(host, []), null, "alone on the stage: carry on");
  eq(shouldYield(panelist, []), null, "a panelist alone: carry on");

  // The takeover itself, from the host's side: the old share was already there.
  eq(
    shouldYield(host, [other("Amlesh", { presentAtStart: true })]),
    null,
    "host taking over keeps their share while the old one stops",
  );
  // …and from the side of the person being taken over.
  eq(
    shouldYield(panelist, [other("Netesh", { privileged: true })]),
    { reason: "takeover", by: "Netesh" },
    "panelist stops when the host takes over",
  );
  eq(
    shouldYield(host, [other("Riya", { privileged: true })]),
    { reason: "takeover", by: "Riya" },
    "host stops when a co-host takes over after them",
  );
  eq(
    shouldYield(host, [other("Riya", { privileged: true, presentAtStart: true })]),
    null,
    "host keeps a takeover of a co-host",
  );
  eq(
    shouldYield(host, [other("Amlesh")]),
    null,
    "a panelist who slipped through never stops a host",
  );
  eq(
    shouldYield(panelist, [other("Amlesh", { presentAtStart: true })]),
    { reason: "taken", by: "Amlesh" },
    "a panelist who slipped through stops for the share that was there first",
  );
  eq(
    shouldYield(panelist, [other("Amlesh")]),
    null,
    "a panelist who started first keeps the stage against a later one",
  );
  eq(
    shouldYield(panelist, [other("Netesh", { privileged: true, presentAtStart: true })]),
    { reason: "takeover", by: "Netesh" },
    "a panelist who slipped through stops for a host already sharing",
  );
  eq(
    shouldYield(panelist, [other("Netesh", { privileged: true, muted: true })]),
    null,
    "a muted share outranks nobody",
  );
  eq(
    shouldYield({ privileged: false, mutedByServer: true }, []),
    { reason: "muted" },
    "the server muting our share stops it",
  );
  eq(
    shouldYield({ privileged: true, mutedByServer: true }, []),
    { reason: "muted" },
    "including a host's: the server only does that to a loser",
  );
});

group("yieldMessage", () => {
  eq(
    yieldMessage({ reason: "takeover", by: "Netesh" }),
    "Netesh took over the screen share.",
    "takeover names who took it",
  );
  ok(yieldMessage({ reason: "taken", by: "Amlesh" }).includes("Amlesh"), "taken names who has it");
  ok(yieldMessage({ reason: "muted" }).length > 0, "muted says something");
});

group("isPrivileged: host or co-host from metadata", () => {
  eq(isPrivileged({ metadata: JSON.stringify({ role: "host" }) }), true, "host");
  eq(
    isPrivileged({ metadata: JSON.stringify({ role: "panelist", coHost: true }) }),
    true,
    "co-host",
  );
  eq(isPrivileged({ metadata: JSON.stringify({ role: "panelist" }) }), false, "panelist");
  eq(isPrivileged({ metadata: JSON.stringify({ role: "attendee" }) }), false, "attendee");
  eq(isPrivileged({ metadata: "" }), false, "no metadata");
  eq(isPrivileged({ metadata: "{not json" }), false, "garbage metadata");
  eq(
    isPrivileged({ metadata: JSON.stringify({ role: "panelist", coHost: "true" }) }),
    false,
    "coHost must be the boolean the API writes",
  );
});

group("shareStartedAt: the SFU's stamp", () => {
  type Info = Parameters<typeof shareStartedAt>[0];
  const pub = (unixMicro: bigint | undefined) =>
    ({ trackInfo: unixMicro === undefined ? {} : { version: { unixMicro } } }) as unknown as Info;
  eq(shareStartedAt(undefined), null, "no publication");
  eq(shareStartedAt(pub(undefined)), null, "no version yet");
  eq(shareStartedAt(pub(BigInt(0))), null, "a zero version is unset");
  eq(shareStartedAt(pub(BigInt(1_760_000_000_000_000))), 1_760_000_000_000_000, "a real stamp");
});

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
