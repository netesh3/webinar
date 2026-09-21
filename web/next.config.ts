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
  // Transformers.js pulls Node-only optional deps (sharp, onnxruntime-node)
  // that webpack would otherwise try to bundle into the captions path.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    return config;
  },
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
