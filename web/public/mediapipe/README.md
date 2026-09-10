# Vendored MediaPipe assets

The selfie-segmentation model and its WASM runtime, served from this origin so virtual
backgrounds work without reaching a third-party CDN at runtime.

`@livekit/track-processors` otherwise fetches the runtime from `cdn.jsdelivr.net` and
the model from `storage.googleapis.com`. Both are routinely blocked on the corporate
networks a webinar audience sits behind, and the failure is silent and per-viewer — a
background that does not load for a quarter of the room is worse than one that is not
offered. `lib/backgrounds.ts` points `assetPaths` here instead.

It also means nobody outside this deployment learns who is in a session from the
asset requests.

## Contents

| Path | Source | Size |
|---|---|---|
| `wasm/` | `node_modules/@mediapipe/tasks-vision/wasm` | ~18 MB |
| `selfie_segmenter.tflite` | [MediaPipe model garden][model] | ~250 KB |

Both WASM variants are kept. `FilesetResolver` picks between them at runtime by
probing for SIMD support, so removing the `nosimd` pair breaks older browsers rather
than saving anything on modern ones.

## Refreshing

`wasm/` must match the `@mediapipe/tasks-vision` version that
`@livekit/track-processors` depends on — a mismatched runtime and model fail at
`ImageSegmenter` creation, not at build time. After bumping either package:

```sh
cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/
curl -sSL -o public/mediapipe/selfie_segmenter.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
```

The directory is excluded from ESLint: the `.js` files are Emscripten output, not ours
to lint and not ours to fix.

[model]: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
