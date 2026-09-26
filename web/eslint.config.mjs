import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  /* The WhatsApp CRM is a module (engage/). Webinar code reaches it only through its
   * public surface, "@/engage" — slots, the nav entry, the CRM page — so the CRM's
   * components, API client and Meta SDK loader can change or be removed without touching
   * a webinar screen. See engage/index.ts and docs/engage/MODULES.md. */
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["engage/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/engage/*", "**/engage/*"],
              message:
                'Import the CRM from "@/engage" only; everything under engage/ is private to it.',
            },
          ],
        },
      ],
    },
  },
  /* And the other way: the CRM may use the shared kit (components/ui, controls, icons,
   * providers; lib/*) but not a webinar screen. A CRM view that needs something a webinar
   * screen has gets it moved into the kit, or asks the API. */
  {
    files: ["engage/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@/components/(?!(ui|controls|icons|providers)$)",
              message:
                "The CRM uses the shared UI kit only (ui, controls, icons, providers), not webinar screens.",
            },
            { regex: "^@/app/", message: "The CRM does not import app routes." },
          ],
        },
      ],
    },
  },
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
    // ONNX Runtime WASM, vendored so Whisper captions do not fetch a CDN.
    "public/onnxruntime/**",
    "**/*.test.ts",
  ]),
]);

export default eslintConfig;
