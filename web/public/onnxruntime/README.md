# ONNX Runtime WASM (captions + humanseg)

The WASM files Transformers.js / ONNX Runtime need for Whisper captions and
PP-HumanSeg backgrounds. Served from this origin so inference does not fetch a
third-party CDN at runtime — the same reason `public/mediapipe` and
`public/rnnoise` exist.

Copied from `node_modules/onnxruntime-web/dist/` after installing
`@huggingface/transformers`. Refresh after bumping that package:

```sh
# Cloudflare Workers assets must stay under 25 MiB per file.
# Only ship the threaded SIMD build (≈14 MiB). Do not copy asyncify / jsep /
# jspi variants — those exceed the Workers limit (25+ MiB).
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs} \
   public/onnxruntime/
```

Entrypoints matter:

- `onnxruntime-web/wasm` (humanseg / backgrounds) → `ort-wasm-simd-threaded.wasm`
  — this is what we ship.
- Default `onnxruntime-web` → jsep (~27 MiB); `onnxruntime-web/webgpu` → asyncify
  (~26 MiB). Those exceed the Workers limit, so they are not under this folder.
  Captions that ask for WebGPU fail to load ORT and fall back to the WASM device
  path in `lib/local-captions.ts`.

The Whisper *weights* are not stored here. They download once from the
Hugging Face Hub (`Xenova/whisper-tiny.en`, quantized) and then live in the
browser cache. Inference itself never leaves the tab.
