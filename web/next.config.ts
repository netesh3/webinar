import type { NextConfig } from "next";

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
  // Standalone output for the container image: Next traces the modules actually
  // reached and emits a self-contained server, so the runtime image carries no
  // node_modules tree and no build tooling. See web/Dockerfile.
  output: "standalone",
  basePath: basePath(),
};

export default nextConfig;
