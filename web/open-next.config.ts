import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal config: no R2 incremental cache. Add r2IncrementalCache later if needed.
export default defineCloudflareConfig({});
