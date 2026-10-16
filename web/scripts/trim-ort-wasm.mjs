#!/usr/bin/env node
/**
 * Cloudflare Workers rejects any static asset over 25 MiB.
 * onnxruntime-web ships asyncify/jsep/jspi WASM above that limit; Next would
 * otherwise copy them into `_next/static/media/` when Transformers imports
 * `onnxruntime-web/webgpu`. We always load WASM from `/onnxruntime/` (public),
 * so delete the oversize variants from node_modules after install.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 25 * 1024 * 1024;
const dir = join(process.cwd(), "node_modules/onnxruntime-web/dist");

let removed = 0;
try {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".wasm") && !name.endsWith(".mjs")) continue;
    if (!/asyncify|jsep|jspi/.test(name)) continue;
    const path = join(dir, name);
    const size = statSync(path).size;
    // Drop companion .mjs with the big .wasm, and any file over the limit.
    if (name.endsWith(".wasm") && size > LIMIT) {
      unlinkSync(path);
      removed++;
      console.log(`trim-ort-wasm: removed ${name} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    } else if (name.endsWith(".mjs") && /asyncify|jsep|jspi/.test(name)) {
      unlinkSync(path);
      removed++;
      console.log(`trim-ort-wasm: removed ${name}`);
    }
  }
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    process.exit(0);
  }
  throw err;
}

if (removed === 0) {
  console.log("trim-ort-wasm: nothing to remove");
}
