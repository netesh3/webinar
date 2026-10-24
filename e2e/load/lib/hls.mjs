/* Just enough of HLS / LL-HLS (RFC 8216 + draft-pantos-hls-rfc8216bis) to play a live stream
 * the way hls.js does with lowLatencyMode: true. MediaMTX's LL-HLS output is the target:
 * a multivariant playlist, then a media playlist with EXT-X-PART, EXT-X-PRELOAD-HINT,
 * EXT-X-SERVER-CONTROL (CAN-BLOCK-RELOAD, PART-HOLD-BACK) and fMP4 (EXT-X-MAP). */

/** Attributes of a tag line: `A=1,B="x,y",C=YES` -> { A: "1", B: "x,y", C: "YES" }. */
export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

export function isMultivariant(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

/** Variants of a multivariant playlist, highest bandwidth first, URIs resolved against base. */
export function parseMultivariant(text, base) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const a = parseAttrs(lines[i].slice("#EXT-X-STREAM-INF:".length));
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l && !l.startsWith("#")) {
        uri = l;
        break;
      }
    }
    if (uri) out.push({ index: out.length, bandwidth: Number(a.BANDWIDTH || 0), resolution: a.RESOLUTION || "", uri: resolve(uri, base) });
  }
  // Alternate renditions (audio) are separate playlists hls.js also loads.
  const media = [];
  for (const l of lines) {
    if (!l.startsWith("#EXT-X-MEDIA:")) continue;
    const a = parseAttrs(l.slice("#EXT-X-MEDIA:".length));
    if (a.URI) media.push({ type: a.TYPE, group: a["GROUP-ID"], uri: resolve(a.URI, base), default: a.DEFAULT === "YES" });
  }
  out.sort((x, y) => y.bandwidth - x.bandwidth);
  return { variants: out, media };
}

/* A media playlist:
 *   { targetDuration, mediaSequence, partTarget, canBlockReload, partHoldBack, holdBack,
 *     map, segments: [{ msn, uri, duration, pdt, parts: [{ uri, duration, independent }] }],
 *     trailingParts: [...] (parts of the segment still being written),
 *     preloadHint: { uri } | null, endList }
 * pdt is ms since the epoch or null. */
export function parseMedia(text, base) {
  const lines = text.split(/\r?\n/);
  const pl = {
    targetDuration: 0,
    mediaSequence: 0,
    partTarget: 0,
    canBlockReload: false,
    partHoldBack: 0,
    holdBack: 0,
    map: null,
    segments: [],
    trailingParts: [],
    preloadHint: null,
    endList: false,
  };
  let parts = [];
  let duration = 0;
  let pdt = null;
  let msn = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#EXT-X-TARGETDURATION:")) pl.targetDuration = Number(l.split(":")[1]);
    else if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) pl.mediaSequence = Number(l.split(":")[1]);
    else if (l.startsWith("#EXT-X-PART-INF:")) pl.partTarget = Number(parseAttrs(l.slice(16))["PART-TARGET"] || 0);
    else if (l.startsWith("#EXT-X-SERVER-CONTROL:")) {
      const a = parseAttrs(l.slice(22));
      pl.canBlockReload = a["CAN-BLOCK-RELOAD"] === "YES";
      pl.partHoldBack = Number(a["PART-HOLD-BACK"] || 0);
      pl.holdBack = Number(a["HOLD-BACK"] || 0);
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(l.slice(11));
      if (a.URI) pl.map = { uri: resolve(a.URI, base) };
    } else if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(l.slice(25));
      pdt = Number.isFinite(t) ? t : null;
    } else if (l.startsWith("#EXT-X-PART:")) {
      const a = parseAttrs(l.slice(12));
      if (a.URI) parts.push({ uri: resolve(a.URI, base), duration: Number(a.DURATION || 0), independent: a.INDEPENDENT === "YES" });
    } else if (l.startsWith("#EXT-X-PRELOAD-HINT:")) {
      const a = parseAttrs(l.slice(20));
      if (a.TYPE === "PART" && a.URI) pl.preloadHint = { uri: resolve(a.URI, base) };
    } else if (l.startsWith("#EXTINF:")) duration = Number(l.slice(8).split(",")[0]);
    else if (l === "#EXT-X-ENDLIST") pl.endList = true;
    else if (!l.startsWith("#")) {
      msn = msn === null ? pl.mediaSequence : msn + 1;
      pl.segments.push({ msn, uri: resolve(l, base), duration, pdt, parts });
      // The next segment's PDT, when the playlist only tags the first one.
      pdt = pdt === null ? null : pdt + duration * 1000;
      parts = [];
      duration = 0;
    }
  }
  pl.trailingParts = parts;
  return pl;
}

/* The next blocking reload, as hls.js lowLatencyMode asks for it: the part after the last one
 * listed (_HLS_msn = the segment being written, _HLS_part = its next part index); without parts,
 * the segment after the last. Null when the server cannot block. */
export function nextBlockingRequest(pl) {
  if (!pl.canBlockReload) return null;
  const lastMsn = pl.segments.length ? pl.segments[pl.segments.length - 1].msn : pl.mediaSequence - 1;
  if (pl.partTarget > 0) return { msn: lastMsn + 1, part: pl.trailingParts.length };
  return { msn: lastMsn + 1, part: null };
}

export function withBlocking(uri, req) {
  if (!req) return uri;
  const u = new URL(uri);
  u.searchParams.set("_HLS_msn", String(req.msn));
  if (req.part !== null && req.part !== undefined) u.searchParams.set("_HLS_part", String(req.part));
  return u.toString();
}

/* The media a player has not fetched yet, in play order. Each item has a `key` (msn * 1000 +
 * part index; a whole segment is msn * 1000 + 999) and the player keeps the key of the last item
 * it fetched as its cursor. In low-latency mode a player fetches parts where the playlist lists
 * them, and whole segments otherwise. Starting up (cursor null), only what is within
 * `startBackSec` of the live edge is fetched, as hls.js starts PART-HOLD-BACK behind live
 * rather than at the oldest segment. */
export function pendingMedia(pl, cursor, { lowLatency = true, startBackSec = 0 } = {}) {
  const items = [];
  // pdt of each item: its segment's PROGRAM-DATE-TIME plus the parts before it.
  const partsOf = (parts, msn, segPdt) => {
    let off = 0;
    parts.forEach((p, i) => {
      items.push({ uri: p.uri, duration: p.duration, msn, pdt: segPdt === null ? null : segPdt + off, part: true, key: msn * 1000 + i });
      off += p.duration * 1000;
    });
  };
  for (const seg of pl.segments) {
    if (lowLatency && seg.parts.length) partsOf(seg.parts, seg.msn, seg.pdt);
    else items.push({ uri: seg.uri, duration: seg.duration, msn: seg.msn, pdt: seg.pdt, part: false, key: seg.msn * 1000 + 999 });
  }
  if (lowLatency) {
    const lastSeg = pl.segments[pl.segments.length - 1];
    const msn = lastSeg ? lastSeg.msn + 1 : pl.mediaSequence;
    const pdt = lastSeg && lastSeg.pdt !== null ? lastSeg.pdt + lastSeg.duration * 1000 : null;
    partsOf(pl.trailingParts, msn, pdt);
  }
  if (cursor === null || cursor === undefined) {
    if (startBackSec <= 0) return items;
    let acc = 0;
    let i = items.length;
    while (i > 0 && acc < startBackSec) acc += items[--i].duration;
    // hls.js starts on an independent part / segment boundary; close enough for load.
    return items.slice(i);
  }
  // A whole segment whose parts were already fetched (key msn*1000+k) is skipped: same media.
  return items.filter((it) => it.key > cursor && !(it.key % 1000 === 999 && Math.floor(cursor / 1000) === it.msn));
}

/** Live edge (ms since epoch) by program date time, or null if the playlist has none. */
export function liveEdgePdt(pl) {
  const last = pl.segments[pl.segments.length - 1];
  if (!last || last.pdt === null) return null;
  let t = last.pdt + last.duration * 1000;
  for (const p of pl.trailingParts) t += p.duration * 1000;
  return t;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}
