/* A stand-in for the API's edge endpoints and a MediaMTX-like LL-HLS origin, so the load
 * tools can be exercised without a video server: node --test e2e/load/test/ starts it.
 *
 *   POST /api/webinars/:slug/join            -> edge JoinResponse
 *   GET  /api/webinars/:slug/events?t=       -> SSE: meta, then a packet every second, ": ping"
 *   POST /api/webinars/:slug/events/beat|leave
 *   GET  /api/webinars/:slug/chat|questions|polls
 *   POST /api/webinars/:slug/say, /polls/:id/vote, /register
 *   GET  /live/:slug/index.m3u8 (multivariant), stream.m3u8 (LL-HLS, blocking reload), parts
 */
import { createServer } from "node:http";

export function startFake({ partMs = 200, partsPerSeg = 4, partBytes = 2000, port = 0 } = {}) {
  const t0 = Date.now();
  const seen = { join: 0, beat: 0, leave: 0, events: 0, say: 0, vote: 0, register: 0, backlog: 0, part: 0, blocking: 0 };
  const partsNow = () => Math.floor((Date.now() - t0) / partMs);
  const playlist = (upTo) => {
    const segs = Math.floor(upTo / partsPerSeg);
    const first = Math.max(0, segs - 6);
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      `#EXT-X-TARGETDURATION:${Math.ceil((partMs * partsPerSeg) / 1000)}`,
      `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${((partMs * 3) / 1000).toFixed(3)}`,
      `#EXT-X-PART-INF:PART-TARGET=${(partMs / 1000).toFixed(3)}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (let s = first; s < segs; s++) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + s * partsPerSeg * partMs).toISOString()}`);
      if (s >= segs - 2) for (let p = 0; p < partsPerSeg; p++) lines.push(`#EXT-X-PART:DURATION=${partMs / 1000},URI="part${s}_${p}.mp4"${p === 0 ? ",INDEPENDENT=YES" : ""}`);
      lines.push(`#EXTINF:${(partMs * partsPerSeg) / 1000},`, `seg${s}.mp4`);
    }
    for (let p = 0; p < upTo % partsPerSeg; p++) lines.push(`#EXT-X-PART:DURATION=${partMs / 1000},URI="part${segs}_${p}.mp4"`);
    lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part${segs}_${upTo % partsPerSeg}.mp4"`);
    return lines.join("\n") + "\n";
  };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let m;
    if ((m = p.match(/^\/api\/webinars\/([^/]+)\/join$/))) {
      seen.join++;
      let body = "";
      for await (const c of req) body += c;
      const { joinKey } = JSON.parse(body || "{}");
      if (!joinKey) return json(403, { error: "registration_required" });
      return json(200, {
        delivery: "edge",
        playbackUrl: `http://127.0.0.1:${server.address().port}/live/${m[1]}/index.m3u8`,
        eventsToken: `tok-${joinKey}`,
        identity: `att_${joinKey}`,
        lowLatency: true,
      });
    }
    if ((m = p.match(/^\/api\/webinars\/([^/]+)\/events$/))) {
      seen.events++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("retry: 2000\n\nevent: meta\ndata: {}\n\n");
      const iv = setInterval(() => res.write('event: packet\ndata: {"kind":"chat"}\n\n: ping\n\n'), 1000);
      res.on("close", () => clearInterval(iv));
      return;
    }
    if (/\/events\/beat$/.test(p)) return seen.beat++, res.writeHead(204).end();
    if (/\/events\/leave$/.test(p)) return seen.leave++, res.writeHead(204).end();
    if (/\/(chat|questions|polls)$/.test(p) && req.method === "GET") return seen.backlog++, json(200, { messages: [], questions: [], polls: [] });
    if (/\/say$/.test(p)) return seen.say++, json(200, { destination: "everyone", recipients: 1 });
    if (/\/polls\/closed\/vote$/.test(p)) return seen.vote++, json(409, { error: "already_voted" });
    if (/\/vote$/.test(p)) return seen.vote++, json(200, {});
    if (/\/register$/.test(p)) return seen.register++, json(201, { state: "unverified", joinKey: "", needsEmailVerification: true });
    if ((m = p.match(/^\/live\/([^/]+)\/index\.m3u8$/))) {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nstream.m3u8\n');
    }
    if (/\/stream\.m3u8$/.test(p)) {
      const msn = u.searchParams.get("_HLS_msn");
      if (msn !== null) {
        seen.blocking++;
        const want = Number(msn) * partsPerSeg + Number(u.searchParams.get("_HLS_part") ?? 0) + 1;
        const deadline = Date.now() + 3 * partMs * partsPerSeg;
        while (partsNow() < want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      }
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end(playlist(partsNow()));
    }
    if (/\.mp4$/.test(p)) {
      seen.part++;
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(Buffer.alloc(partBytes));
    }
    json(404, { error: "not_found" });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) }),
    ),
  );
}
