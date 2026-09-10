/* Is this deployment actually reachable from the outside world?
 *
 *   node infra/portable/preflight.mjs events.example.com
 *
 * Run from your laptop, on a network that is not the server's. Everything here is a
 * check the machine cannot perform on itself: a cloud security group blocks traffic
 * before it reaches the kernel, so from inside the box the firewall looks wide open and
 * `ss -lntup` shows every port listening happily. The only way to know is to knock.
 *
 * No dependencies — node's own net, tls and dns.
 *
 * THIS USED TO BE MOSTLY ABOUT UDP, and it no longer is. The SFU ran on this host, so the
 * interesting question was whether the provider passed UDP at all: a 20-byte STUN Binding
 * Request to the embedded TURN server on 3478/udp answered if and only if UDP traversed
 * the whole path, and it was the one cheap unambiguous test available. There was a second,
 * unanswerable question behind it — whether the 50000-60060 media range was open — because
 * nothing listens on a port in that range until a participant is assigned it.
 *
 * Both questions are gone. Media goes to LiveKit Cloud, not to this machine, so this host
 * needs no UDP and no media range. What is left is three TCP ports, a certificate and one
 * HTTP request, all of which have definite answers.
 *
 * WHAT THIS STILL CANNOT TELL YOU. Whether a browser can actually establish media with
 * LiveKit Cloud — that depends on the VIEWER's network, not the server's, and it is the
 * one thing this host is no longer responsible for. `e2e/probe-room.mjs` joins a real room
 * and reports the selected ICE candidate pair, which remains the authoritative answer.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { promises as dns } from "node:dns";

const domain = (process.argv[2] ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
if (!domain) {
  console.error("usage: node infra/portable/preflight.mjs <domain>");
  process.exit(2);
}

let failures = 0;
let warnings = 0;
const pass = (m) => console.log(`  \x1b[1;32m✓\x1b[0m ${m}`);
const fail = (m, hint) => {
  failures++;
  console.log(`  \x1b[1;31m✗\x1b[0m ${m}`);
  if (hint) console.log(`     \x1b[2m${hint}\x1b[0m`);
};
const warn = (m, hint) => {
  warnings++;
  console.log(`  \x1b[1;33m!\x1b[0m ${m}`);
  if (hint) console.log(`     \x1b[2m${hint}\x1b[0m`);
};
const head = (m) => console.log(`\n\x1b[1;34m==>\x1b[0m ${m}`);

/** A TCP port that accepts a connection within `ms`. */
function tcpOpen(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** The TLS certificate actually served, so an ACME failure is not mistaken for DNS. */
function certFor(host, ms = 6000) {
  return new Promise((resolve) => {
    const sock = tlsConnect({ host, port: 443, servername: host, timeout: ms }, () => {
      const cert = sock.getPeerCertificate();
      sock.destroy();
      resolve({ ok: sock.authorized, subject: cert?.subject?.CN, issuer: cert?.issuer?.O, to: cert?.valid_to });
    });
    sock.once("error", (err) => resolve({ ok: false, error: err.message }));
    sock.once("timeout", () => {
      sock.destroy();
      resolve({ ok: false, error: "timed out" });
    });
  });
}

// ------------------------------------------------------------------ 1. DNS

head(`DNS for ${domain}`);
let ip = null;
try {
  const [a] = await dns.resolve4(domain);
  ip = a;
  pass(`${domain} -> ${ip}`);
} catch {
  fail(`${domain} does not resolve`, "add an A record before anything else can work");
}

// No sfu.<domain> check. That record pointed at the SFU container that used to run on
// this host; LiveKit Cloud has its own hostname and its own certificate. A leftover
// record is harmless and can be deleted.

if (!ip) {
  console.log("\nNo address to test against. Fix DNS and re-run.\n");
  process.exit(1);
}

// ------------------------------------------------------------------ 2. TCP

head("TCP");
for (const [port, what, hint] of [
  [80, "ACME HTTP challenge and the redirect to 443", "Caddy cannot get a certificate without it"],
  [443, "the app itself", null],
  // No 7881. It was ICE-over-TCP into the SFU that used to run here; browsers reach
  // LiveKit Cloud directly now, including its TLS/443 relay, so this host needs neither
  // that port nor any UDP. If it is still open in your firewall, close it.
]) {
  const open = await tcpOpen(ip, port);
  open ? pass(`${port}/tcp open — ${what}`) : fail(`${port}/tcp CLOSED — ${what}`, hint);
}

/* No UDP section.
 *
 * There was one, and it was the most valuable check in this file: a STUN Binding Request
 * to 3478/udp. It is deliberately gone rather than kept as a warning, because with no SFU
 * on this host nothing answers on 3478 — so a check that "fails" on every correct
 * deployment is worse than no check. A preflight that cries wolf is one people learn to
 * ignore, including on the run where something is genuinely wrong.
 */

// ------------------------------------------------------------------ 4. TLS and the app

head("TLS and the application");
const cert = await certFor(domain);
if (cert.ok) {
  pass(`certificate valid, issued by ${cert.issuer ?? "?"}, expires ${cert.to}`);
} else {
  fail(`TLS failed: ${cert.error ?? "not authorised"}`, "check `docker compose logs caddy` for the ACME exchange");
}

/* /api/config rather than /healthz, and the reason is worth knowing before you go
 * looking for a health endpoint that answers.
 *
 * The API does serve /healthz and /readyz, but at its own root — and Caddy only forwards
 * /api/* to the API, sending everything else to Next.js. So /healthz reaches the web
 * container and 404s, and /api/healthz reaches the API at a path it never registered and
 * 404s too. Both are reachable only from inside the compose network, which is exactly
 * what a container healthcheck wants and no use at all from out here.
 *
 * /api/config is the right probe instead: public by design, no auth, and it can only
 * answer if Caddy is routing AND the API is up AND the API could read its own config. */
try {
  const res = await fetch(`https://${domain}/api/config`, { signal: AbortSignal.timeout(8000) });
  res.ok ? pass(`GET /api/config -> ${res.status}`) : fail(`GET /api/config -> ${res.status}`);
} catch (err) {
  fail(`GET /api/config failed: ${err.message}`, "the API container may not be healthy yet");
}

// ------------------------------------------------------------------ verdict

console.log("");
if (failures) {
  console.log(`\x1b[1;31m${failures} check(s) failed\x1b[0m${warnings ? `, ${warnings} warning(s)` : ""}.`);
  console.log("Fix these before pointing anybody at the URL.\n");
  process.exit(1);
}
console.log(
  `\x1b[1;32mAll checks passed\x1b[0m${warnings ? `, with ${warnings} warning(s)` : ""}.`,
);
console.log(`
This proves the app is reachable. It does not prove that media works, because media no
longer involves this host at all — a browser connects to LiveKit Cloud directly. Settle
that by joining a real room:

  node e2e/probe-room.mjs https://${domain}

You want a selected candidate pair, ideally containing 'udp'. 'tcp' or 'relay' means the
viewer's network is blocking UDP and LiveKit Cloud fell back for them, which is the case
the self-hosted SFU could not handle at all — it works, and it is slower.
`);
