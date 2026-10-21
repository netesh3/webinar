# Security scans

Static scans run in `.github/workflows/security.yml`: on every push to main, weekly, and on
demand (Actions → Security scans → Run workflow). Each run uploads the raw scanner output as
an artifact. That output is the evidence for third-party security reviews such as the Zoom
Marketplace review.

| Scanner | What it checks | Fails the run when |
| --- | --- | --- |
| `govulncheck` v1.9.0 | Known Go vulnerabilities, standard library included, filtered to code we actually call | Our code reaches a vulnerable function |
| `gosec` v2.29.0 | Go source: injection, unsafe file access, weak crypto and randomness, cookie flags, redirects, and similar | Any unsuppressed finding, or a package that fails to type-check |
| `npm audit` | Known advisories in the web app's production dependencies | Any critical advisory, or a high one not accepted below |

Run them locally:

```sh
cd api
CGO_ENABLED=0 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -show verbose ./...
# gosec has to be built against golang.org/x/tools v0.52+ to type-check Go 1.27;
# see the "Build gosec" step in the workflow.
cd ../web && npm audit --omit=dev
```

## Triage rules

- **Fix** a real issue: bump the Go version or a module, change the code, or bump an npm package
  within the same major version (an `overrides` entry when the package is transitive).
- **Suppress a gosec false positive** at the line with `// #nosec <rule> -- <why it is safe>`.
  The reason is required. Never exclude a whole rule.
- **Accept an npm advisory** only when it cannot be reached from how we use the package and no
  compatible fix exists. Add its id to `ACCEPTED` in the workflow and list it below.

## First run (17 Oct 2026)

**govulncheck.** Found 12 reachable standard-library vulnerabilities in Go 1.27.1: `net/http`,
the HTTP/2 transport, `crypto/tls`, `net/textproto` and `html/template`. Fixed by moving
`api/go.mod` to Go 1.27.2. One advisory remains in a module we require but never call:
GO-2026-5932 (`golang.org/x/crypto/openpgp` is unmaintained). We do not import `openpgp`,
and there is no fixed version.

**21 Oct 2026.** GO-2026-6809 (`crypto/x509` trusted compromised intermediate certificates)
was reachable from the S3 media reader in Go 1.27.2. Fixed by moving `api/go.mod` to Go 1.27.3.

**gosec.** Found 61 findings. All were reviewed, and the following were fixed or annotated:

- Recording files on the local-disk backend are now created owner-only (0600, was 0640).
- Paths on the local-disk backend come from `Disk.path`, which refuses keys that escape the
  root (G304).
- The rest were false positives, each annotated at its line. They are:
  - endpoint URLs and header names that look like credentials (G101);
  - the development-only LiveKit key, which is refused outside development (G101);
  - seeded randomness for synthetic demo data (G404);
  - `tel:` and `mailto:` links built from sanitised or operator-set values (G203);
  - integer conversions of bounded values (G115);
  - background work that has to outlive its request (G118);
  - cookies whose `Secure` flag follows `COOKIE_SECURE` (G124). It is on outside
    development, and they are all `HttpOnly` with `SameSite` set;
  - redirects to allowlisted origins or our own presigned storage URLs (G710);
  - content echoed only as JSON or `text/plain` after verification (G705);
  - form parsing behind `http.MaxBytesReader` (G120);
  - ignored `Close` errors on read-only handles (G104).

**npm audit (production).** Found 11 high advisories. The following were fixed in
`web/package.json` `overrides` with same-major bumps:

- `lodash-es` 4.17.21 → 4.18.1, for code injection in `_.template` and prototype pollution.
- Excalidraw's `nanoid` 3.3.3 → 3.3.18.
- `sass` 1.51.0 → 1.105.2. Excalidraw pins sass, but the app has no Sass files. The bump also
  removes the vulnerable `chokidar`/`braces` from production.
- `source-map-js` 1.2.1 → 1.2.2.

Accepted:

| Advisory | Package | Why it is accepted |
| --- | --- | --- |
| GHSA-5j98-mcp5-4vw2 | `glob` 10.3.3 (via `@opennextjs/cloudflare` → `@opennextjs/aws` → `@node-minify/core`) | Command injection in the `glob` **command-line tool's** `-c` option. OpenNext calls glob as a library at build time; the CLI never runs. npm's only suggested fix is downgrading OpenNext. |
| GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w | `nanoid` 4.0.2 (via `@excalidraw/mermaid-to-excalidraw`) | Each needs a caller to pass a negative, zero, non-integer or huge size, or a custom generator. The library only calls the default `nanoid()`. The fix is nanoid 5, a major version its dependent doesn't support. |

Low and moderate advisories remaining: `katex` and `mermaid` through Excalidraw's diagram
import. They are reviewed on each run and not accepted permanently.
