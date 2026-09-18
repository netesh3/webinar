# Vendored RNNoise assets

The RNNoise AudioWorklet processor and its WASM runtime, served from this origin for
the same reason `public/mediapipe` is: `lib/noise-suppression.ts` needs a URL to hand
`audioContext.audioWorklet.addModule()` and `loadRnnoise()`, and pointing those at a
third-party CDN means the enhanced noise suppression silently fails to start for
anyone whose network blocks it — routinely true on the corporate networks a webinar
audience sits behind.

It also means nobody outside this deployment learns who is in a session from the
asset requests.

## Contents

| Path | Source | Size |
|---|---|---|
| `workletProcessor.js` | `@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js` | ~65 KB |
| `rnnoise.wasm` | `@sapphi-red/web-noise-suppressor/rnnoise.wasm` | ~150 KB |
| `rnnoise_simd.wasm` | `@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm` | ~155 KB |

Both WASM variants are kept. `loadRnnoise` picks between them at runtime by probing
for SIMD support, same reasoning as the two MediaPipe WASM variants next door.

## Refreshing

After bumping `@sapphi-red/web-noise-suppressor`:

```sh
cp node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js public/rnnoise/workletProcessor.js
cp node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm public/rnnoise/rnnoise.wasm
cp node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm public/rnnoise/rnnoise_simd.wasm
cp node_modules/@sapphi-red/web-noise-suppressor/LICENSE public/rnnoise/LICENSE
```

The directory is excluded from ESLint: `workletProcessor.js` is bundled/minified
output, not ours to lint and not ours to fix.
