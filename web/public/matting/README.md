# MODNet portrait matting (Enhanced background, WebGPU)

`modnet.onnx` is [MODNet](https://github.com/ZHKKKe/MODNet) (Apache-2.0), the ONNX
export published as
[`onnx-community/modnet-webnn`](https://huggingface.co/onnx-community/modnet-webnn)
(`onnx/model.onnx`, fp32, 25,888,640 bytes, sha256
`07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`).

Served from this origin for the same reason as `public/mediapipe`: a webinar must not
depend on a CDN a corporate network may block. It is fetched only by a presenter who
turns a background on, in a browser with WebGPU, and then cached (see `public/_headers`).

`lib/modnet.ts` runs it with the onnxruntime-web build in `public/onnxruntime`. The
file is just under Cloudflare Workers' 25 MiB per-asset limit; a larger export would
not deploy.

Where it is used, and where MediaPipe is used instead, is in `lib/segmenter.ts`
(search for MODNet). Build-time switches, both on unless set to `0`:

- `NEXT_PUBLIC_VB_MODNET` — MODNet on WebGPU; `0` keeps every browser on MediaPipe.
- `NEXT_PUBLIC_VB_PRESENTER_LOCK` — keep only the presenter; `0` keeps everybody.
