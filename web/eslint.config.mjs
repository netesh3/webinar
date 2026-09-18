import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".open-next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // MediaPipe's WASM loader, vendored from @mediapipe/tasks-vision so the
    // segmentation model is served from this origin rather than fetched from a
    // third-party CDN at runtime. Emscripten-generated: not ours to lint, and not
    // ours to fix.
    "public/mediapipe/**",
    // RNNoise's AudioWorklet processor, vendored from @sapphi-red/web-noise-suppressor
    // for the same reason — served from this origin, not a CDN. Also bundled/minified
    // output: not ours to lint.
    "public/rnnoise/**",
  ]),
]);

export default eslintConfig;
