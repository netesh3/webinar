# Background segmentation model

`humanseg.onnx` is **PP-HumanSegV2-Lite** from
[PaddleSeg](https://github.com/PaddlePaddle/PaddleSeg/tree/release/2.9/contrib/PP-HumanSeg)
(Apache-2.0), the 256×144 portrait-segmentation export, converted to ONNX with
`paddle2onnx` (opset 11). sha256
`e2e9445d874b5fb119a01be5b2c5f33baa2a5de7bf7959f5b62fceb26c66a0e2`, 3,814,964 bytes.

One fix was needed after conversion: paddle2onnx wrote the model's `AveragePool` nodes
without `kernel_shape`/`strides`, which onnxruntime rejects. They were filled in from the
tensor shapes on each side of each node, with the `onnx` Python package.

Input `[1, 3, 144, 256]`, RGB, `(x / 255 − 0.5) / 0.5`. Output `[1, 2, 144, 256]`,
softmax over `[background, person]`.

Served from this origin for the same reason as `public/mediapipe`: a webinar must not
depend on a CDN a corporate network may block. `lib/humanseg.ts` runs it on the
onnxruntime-web WebAssembly build in `public/onnxruntime`, on every browser — there is no
other segmentation model. `lib/segmenter.ts` composites with it; `lib/presenter-lock.ts`
keeps only the presenter. `NEXT_PUBLIC_VB_PRESENTER_LOCK=0` at build time keeps everybody.
