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
| `wasm/` | `node_modules/@mediapipe/tasks-vision/wasm` | ~34 MB |
| `selfie_segmenter.tflite` | [MediaPipe model garden][model] | ~250 KB |
| `selfie_segmenter_landscape.tflite` | [MediaPipe model garden][model], same task, `selfie_segmenter_landscape` slug | ~250 KB |

`lib/segmenter.ts` only loads the landscape model — see its own comment for why
(the square model squashes a 16:9 frame). The plain one is kept vendored anyway,
in case a future caller wants the square model's tighter framing on a portrait feed.

All three WASM pairs are kept, not just the SIMD/no-SIMD two: 1.0 added a third
`vision_wasm_module_internal` pair for an ES-module loading path, opted into via a
second argument to `FilesetResolver.forVisionTasks` that this codebase does not pass —
so it is unused today, but removing it on a version bump would be one commit away from
silently mattering. `FilesetResolver` picks the SIMD/no-SIMD pair at runtime by probing
for SIMD support, so removing that pair breaks older browsers rather than saving
anything on modern ones.

## Refreshing

`wasm/` must match the `@mediapipe/tasks-vision` version actually installed at the
repo root (see `web/package.json`) — a mismatched runtime and model fail at
`ImageSegmenter` creation, not at build time. `@livekit/track-processors` pins its own
exact `@mediapipe/tasks-vision` version as a dependency, which can trail this one; that
is harmless here because this codebase's transformer (`lib/segmenter.ts`) calls
`@mediapipe/tasks-vision` directly and never instantiates track-processors' own
MediaPipe-based `BackgroundTransformer`, the only thing of theirs that would care.

After bumping either package:

```sh
cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/
curl -sSL -o public/mediapipe/selfie_segmenter.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
curl -sSL -o public/mediapipe/selfie_segmenter_landscape.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite"
```

The directory is excluded from ESLint: the `.js` files are Emscripten output, not ours
to lint and not ours to fix.

[model]: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
