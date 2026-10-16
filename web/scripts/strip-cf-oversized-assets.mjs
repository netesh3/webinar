#!/usr/bin/env node
/**
 * Cloudflare Workers rejects any static asset over 25 MiB.
 *
 * Captions / humanseg load ONNX Runtime WASM from /onnxruntime/ (≈14 MiB
 * threaded build). If a bundler still copies an oversized asyncify/jsep
 * variant into `.open-next/assets`, drop it before wrangler/miniflare walks
 * the directory — those hashed media URLs are never fetched at runtime.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 25 * 1024 * 1024;
const root = join(process.cwd(), ".open-next/assets");

function walk(dir) {
  let removed = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      removed += walk(path);
      continue;
    }
    const size = statSync(path).size;
    if (size <= LIMIT) continue;
    unlinkSync(path);
    removed++;
    console.log(
      `strip-cf-oversized-assets: removed ${path} (${(size / 1024 / 1024).toFixed(1)} MiB)`,
    );
  }
  return removed;
}

try {
  const n = walk(root);
  if (n === 0) console.log("strip-cf-oversized-assets: nothing over 25 MiB");
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    console.log("strip-cf-oversized-assets: no .open-next/assets yet; skip");
    process.exit(0);
  }
  throw err;
}
