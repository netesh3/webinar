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
  /* Empty, and load-bearing. Next 16 runs Turbopack by default and refuses to
   * build when it finds a `webpack` config with no `turbopack` config beside
   * it — which is what broke this build, since the webpack config it was
   * complaining about could never have run. */
  turbopack: {},
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
        ],
      },
    ];
  },
};

export default nextConfig;

// Local `next dev` integration with Cloudflare bindings (no-op in production builds).
initOpenNextCloudflareForDev();
