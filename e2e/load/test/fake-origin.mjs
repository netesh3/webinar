// node e2e/load/test/fake-origin.mjs [port]: the fake LL-HLS origin alone, for a local API whose
// BROADCAST_HLS_BASE is http://127.0.0.1:<port>/live (docs/LOAD-TESTING.md, "Trying it locally").
import { startFake } from "./fake-server.mjs";

const port = Number(process.argv[2] ?? 18090);
const f = await startFake({ port, partMs: 500, partsPerSeg: 4, partBytes: 60_000 });
console.log(`fake LL-HLS origin on ${f.url}/live/<slug>/index.m3u8 (0.5 s parts, 2 s segments, ~1 Mbit/s)`);
setInterval(() => console.log(JSON.stringify(f.seen)), 30_000);
