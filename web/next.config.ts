import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** Serve the whole app under a sub-path, e.g. "/platform/webcast".
 *
 *  This has to be baked in at build time — Next rewrites every asset URL,
 *  `<Link>` href and router path against it, so it cannot be a runtime variable.
 *  Empty means mounted at the root, which is what local development and the
 *  single-VPS compose deployment both want; `undefined` rather than `""` because
 *  Next validates the value and rejects an empty string.
 *
 *  When this is set, two other things have to agree with it or links break:
 *    NEXT_PUBLIC_API_BASE=<basePath>   so browser fetches hit the same mount
 *    WEB_BASE_URL=https://host<basePath>   so API-generated share links do too
 */
function basePath(): string | undefined {
  const raw = process.env.BASE_PATH?.trim();
  if (!raw || raw === "/") return undefined;
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, "");
}

const nextConfig: NextConfig = {
  // Standalone for the container image (web/Dockerfile). Skip when building for
  // Cloudflare OpenNext — that adapter transforms the default Next output.
  ...(process.env.OPEN_NEXT !== "1" ? { output: "standalone" as const } : {}),
  basePath: basePath(),
  /* Captions run Whisper in the speaker's own browser (lib/local-captions.ts),
   * on the WASM / WebGPU backend with the runtime served from /onnxruntime.
   * Nothing on the server ever loads Transformers.js.
   *
   * The server still has to be told that. Its exports map has a `node`
   * condition, and Next's output file tracer resolves with Node conditions —
   * so it followed transformers.node.mjs into onnxruntime-node and sharp and
   * traced 97 files of native binary (.node, .dylib) into the route. OpenNext
   * copies the trace into the Workers server function, where esbuild has no
   * loader for a .node file and stops. Workers could not have run one anyway.
   *
   * Excluded from the trace rather than marked serverExternalPackages, which
   * made it worse: external means "require it at runtime", so the real package
   * was copied in whole. Nothing requires it at runtime on the server. */
  outputFileTracingExcludes: {
    "**": [
      "./node_modules/@huggingface/transformers/**",
      "./node_modules/onnxruntime-node/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
    ],
  },
  /* Sibling turbopack config required whenever webpack is set (Next 16).
   * Production uses `next build --webpack` so the export condition below
   * selects onnxruntime-web's extern-wasm builds (no embedded >25 MiB .wasm).
   * Runtime still loads binaries from /onnxruntime/ (local-captions, humanseg). */
  turbopack: {},
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    // Prefer package exports that omit embedded wasm (see onnxruntime-web
    // package.json "onnxruntime-web-use-extern-wasm" conditions).
    config.resolve.conditionNames = [
      "onnxruntime-web-use-extern-wasm",
      ...(config.resolve.conditionNames ?? [
        "browser",
        "module",
        "import",
        "require",
        "default",
      ]),
    ];
    return config;
  },
  // No "X-Powered-By: Next.js" on responses: it tells a scanner what to try.
  poweredByHeader: false,
  // Local same-origin `/api` is handled by app/api/[...path]/route.ts (cookie
  // softening for http://localhost). Production Workers use worker.ts instead.
  async headers() {
    return [
      {
        // Chrome's FedCM One Tap is gated on this permission. Without it the
        // GIS prompt fails silently (not displayed / skipped) and Google sign-in
        // looks broken even though "Continue with Google" OAuth still works.
        source: "/:path*",
        headers: [
          {
            key: "Permissions-Policy",
            value: 'identity-credentials-get=(self "https://accounts.google.com")',
          },
          /* Browser hardening that Zoom's Marketplace security review (and any
           * scanner) checks for.
           *
           * HSTS: HTTPS only for a year. No includeSubDomains, so a subdomain that
           * is not on HTTPS yet is not locked out.
           *
           * The CSP sets only directives that cannot break a page: no other site
           * may frame ours (clickjacking), no plugins, no <base> hijack. A full
           * script/connect allowlist would have to cover Google sign-in, Razorpay,
           * LiveKit and R2, and is not worth the breakage risk here.
           * X-Frame-Options is the same rule for browsers without frame-ancestors. */
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000",
          },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      /* The service worker (public/sw.js), for `next start` and the container image. On
       * Workers the asset server answers /sw.js before Next runs, so the same headers are
       * in public/_headers as well. */
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;

// Local `next dev` integration with Cloudflare bindings (no-op in production builds).
initOpenNextCloudflareForDev();
