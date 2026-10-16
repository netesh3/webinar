/* The shared whiteboard's wire format and the rules for believing it.
 *
 * A separate flow from everything in realtime.ts, on purpose: its own topics, its
 * own messages, its own decoder. realtime.ts drops any packet whose topic is not
 * DATA_TOPIC, so nothing here can reach chat, Q&A or the hand queue, and with the
 * feature off (JoinResponse.whiteboard) nobody ever sends one of these at all.
 *
 * Pure: no React, no LiveKit, no Excalidraw. The room hook (use-whiteboard.ts) does
 * the sending; this decides what a packet means and whether to trust it, which is
 * the part worth testing (whiteboard.test.mts).
 *
 * How a board travels:
 *
 *   open    somebody on the stage started a board. Carries a fresh board id, so
 *           a straggling packet from a board that already closed cannot reopen it.
 *   scene   elements. `full` is the opener's whole board, re-sent every few
 *           seconds and to anyone who connects, which is how a late joiner — and
 *           a hidden attendee nobody's client can see arrive — catches up. A
 *           partial scene is only what changed since the sender last sent.
 *   close   the board is over for everyone.
 *   ptr     a cursor, lossy, on its own topic so a burst of them cannot queue
 *           behind a large scene.
 *
 * Scenes go as LiveKit text streams (chunked and compressed by the SDK), so a big
 * board has no packet-size ceiling. Pointers are tiny and go as plain data packets.
 */

/** Text-stream topic for open / scene / close. */
export const WB_TOPIC = "webcast.whiteboard";
/** Data-packet topic for cursors. */
export const WB_POINTER_TOPIC = "webcast.whiteboard.ptr";

/** How often the opener re-sends the whole board while it is open. */
export const WB_SNAPSHOT_MS = 8_000;
/** How long a partial scene waits for more changes before it goes. */
export const WB_SEND_THROTTLE_MS = 120;
/** How often this browser sends its own cursor. */
export const WB_POINTER_THROTTLE_MS = 60;

/** Caps on what a receiver will take, so one patched client cannot hand
 *  everyone's browser a board that freezes the tab. */
export const WB_MAX_ELEMENTS = 5_000;
export const WB_MAX_TEXT = 4 * 1024 * 1024;

/** Enough of an Excalidraw element to merge it: the rest is passed through. */
export type WbElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
};

export type WbOpen = { k: "open"; board: string; name: string };
export type WbClose = { k: "close"; board: string };
export type WbScene = { k: "scene"; board: string; full: boolean; elements: WbElement[] };
export type WbMessage = WbOpen | WbClose | WbScene;

export type WbPointer = {
  k: "ptr";
  board: string;
  name: string;
  x: number;
  y: number;
  tool: "pointer" | "laser";
  button: "up" | "down";
};

// ------------------------------------------------------------------- decode

function boardId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : null;
}

function shortName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function element(value: unknown): WbElement | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 64) return null;
  if (typeof e.type !== "string") return null;
  if (!Number.isFinite(e.version) || !Number.isFinite(e.versionNonce)) return null;
  return e as WbElement;
}

/** A scene / open / close off the wire, or null for anything else. */
export function decodeWb(text: string): WbMessage | null {
  if (text.length > WB_MAX_TEXT) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const board = boardId(m.board);
  if (!board) return null;
  switch (m.k) {
    case "open":
      return { k: "open", board, name: shortName(m.name) };
    case "close":
      return { k: "close", board };
    case "scene": {
      if (!Array.isArray(m.elements) || m.elements.length > WB_MAX_ELEMENTS) return null;
      const elements: WbElement[] = [];
      for (const value of m.elements) {
        const e = element(value);
        if (e) elements.push(e);
      }
      return { k: "scene", board, full: m.full === true, elements };
    }
    default:
      return null;
  }
}

/** A cursor off the wire, or null. */
export function decodePointer(text: string): WbPointer | null {
  if (text.length > 2048) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const board = boardId(m.board);
  if (m.k !== "ptr" || !board) return null;
  if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
  return {
    k: "ptr",
    board,
    name: shortName(m.name),
    x: m.x as number,
    y: m.y as number,
    tool: m.tool === "laser" ? "laser" : "pointer",
    button: m.button === "down" ? "down" : "up",
  };
}

// -------------------------------------------------------------------- trust

/* Who may draw — and so whose packets are believed.
 *
 * The host and the scheduled panelists, the same people the server offers the
 * whiteboard to (JoinResponse.whiteboard). Read from the participant's metadata,
 * which the SERVER writes into their token (lk.Metadata), so a client cannot
 * claim it. An attendee promoted onto the stage holds a data grant, but they are
 * `promoted` in that metadata and watch the board like the rest of the audience.
 */
export function mayDraw(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const m = JSON.parse(metadata) as { role?: unknown; promoted?: unknown };
    if (m.role === "host") return true;
    return m.role === "panelist" && m.promoted !== true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- state

/** Whether a board is open in this room, and whose it is. */
export type WbState = { board: string; owner: string; ownerName: string } | null;

/* What a trusted packet does to the room's board state.
 *
 * A scene for a board we do not have opens it: that is a late joiner arriving
 * mid-board (the `open` went out before they were here). A scene or close for a
 * board that is not this one is ignored, so packets in flight from a board that
 * just closed cannot bring it back.
 */
export function reduceWb(state: WbState, msg: WbMessage, from: string, fromName: string): WbState {
  switch (msg.k) {
    case "open":
      return { board: msg.board, owner: from, ownerName: msg.name || fromName };
    case "close":
      return state?.board === msg.board ? null : state;
    case "scene":
      if (state?.board === msg.board) return state;
      // Only a full scene opens a board we missed: a partial one from another
      // editor says nothing about who opened it.
      return msg.full ? { board: msg.board, owner: from, ownerName: fromName } : state;
  }
}

// ------------------------------------------------------------------ merging

/* The newest copy of each element wins — Excalidraw's own rule: the higher
 * `version`, and on a tie the lower `versionNonce`, so two browsers that edited
 * the same shape at once settle on the same one without talking to each other.
 */
export function newer(a: WbElement, b: WbElement): WbElement {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return a.versionNonce <= b.versionNonce ? a : b;
}

/** Folds remote elements into a map of the latest copy of each. Returns whether
 *  anything changed. */
export function mergeInto(scene: Map<string, WbElement>, incoming: readonly WbElement[]): boolean {
  let changed = false;
  for (const e of incoming) {
    const have = scene.get(e.id);
    const keep = have ? newer(have, e) : e;
    if (keep !== have) {
      scene.set(e.id, keep);
      changed = true;
    }
  }
  return changed;
}

/* What this browser has not sent yet.
 *
 * `known` is the last version of each element this browser has either sent or
 * received. Recording received versions too is what stops an echo: applying a
 * remote scene fires Excalidraw's onChange, and without it every receiver would
 * send the same elements straight back. Updates `known` in place.
 */
export function unsent(elements: readonly WbElement[], known: Map<string, number>): WbElement[] {
  const out: WbElement[] = [];
  for (const e of elements) {
    if (known.get(e.id) === e.version) continue;
    known.set(e.id, e.version);
    out.push(e);
  }
  return out;
}

/** Marks elements as already seen, for the echo rule above. */
export function noteKnown(elements: readonly WbElement[], known: Map<string, number>): void {
  for (const e of elements) {
    const have = known.get(e.id);
    if (have === undefined || e.version >= have) known.set(e.id, e.version);
  }
}

/** A new board id. Not a secret — only needs to differ from the last board's. */
export function newBoardId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
