# ONNX Runtime WASM (captions)

The WASM files Transformers.js / ONNX Runtime need to run Whisper in the
browser. Served from this origin so captions do not fetch a third-party CDN
at runtime — the same reason `public/mediapipe` and `public/rnnoise` exist.

Copied from `node_modules/onnxruntime-web/dist/` after installing
`@huggingface/transformers`. Refresh after bumping that package:

```sh
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs} \
   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.{wasm,mjs} \
   public/onnxruntime/
```

The Whisper *weights* are not stored here. They download once from the
Hugging Face Hub (`Xenova/whisper-tiny.en`, quantized) and then live in the
browser cache. Inference itself never leaves the tab.
