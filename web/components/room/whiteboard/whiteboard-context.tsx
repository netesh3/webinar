"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant, type RemoteParticipant } from "livekit-client";
import {
  WB_POINTER_THROTTLE_MS,
  WB_POINTER_TOPIC,
  WB_SEND_THROTTLE_MS,
  WB_SNAPSHOT_MS,
  WB_TOPIC,
  decodePointer,
  decodeWb,
  mayDraw,
  mergeInto,
  newBoardId,
  noteKnown,
  reduceWb,
  unsent,
  type WbElement,
  type WbMessage,
  type WbPointer,
  type WbState,
} from "@/lib/whiteboard";

/* The room's whiteboard: whether one is open, its elements, and the wire.
 *
 * A flow of its own, beside realtime.ts rather than inside it — own topics, own
 * context, own provider — so the chat, Q&A and hand-queue paths are byte-for-byte
 * what they were. Outside this provider (the preview room, the CDN audience room)
 * useWhiteboard() is null and every caller renders exactly what it did before.
 *
 * `canDraw` is JoinResponse.whiteboard: the host's account switch is on and this
 * person is the host or a scheduled panelist. Everyone else — the audience, an
 * attendee promoted onto the stage — only ever watches a board that one of those
 * people opened, and nobody sends anything here unless the switch is on.
 *
 * The elements live in this hook, not in the canvas, so a board survives the
 * canvas being unmounted (a phone rotating, the lazy chunk still loading) and a
 * late joiner has something to render the moment the canvas mounts.
 */

export type WbCollaborator = {
  name: string;
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "up" | "down";
};

/** What the canvas needs from the hub. */
export type WbCanvasLink = {
  /** Every element this browser knows about, deleted ones included. */
  elements: () => WbElement[];
  /** Called with remote elements to fold into the editor. Returns an
   *  unsubscribe. */
  onRemote: (fn: (elements: WbElement[]) => void) => () => void;
  /** The editor changed — send what is new. No-op for a viewer. */
  localChange: (elements: readonly WbElement[]) => void;
  /** This browser's cursor moved. No-op for a viewer. */
  localPointer: (p: { x: number; y: number; tool: "pointer" | "laser"; button: "up" | "down" }) => void;
};

export type WhiteboardApi = {
  /** This person may open, draw on and close a board. */
  canDraw: boolean;
  /** The board open in the room, or null. */
  state: WbState;
  /** Whether the open board is this browser's own. */
  isOwner: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Other people's cursors, by identity. */
  collaborators: ReadonlyMap<string, WbCollaborator>;
  link: WbCanvasLink;
};

const WhiteboardContext = createContext<WhiteboardApi | null>(null);

/** Null outside the live room, or before the provider mounts. */
export function useWhiteboard(): WhiteboardApi | null {
  return useContext(WhiteboardContext);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function WhiteboardProvider({
  canDraw,
  me,
  children,
}: {
  canDraw: boolean;
  me: { identity: string; name: string };
  children: ReactNode;
}) {
  const room = useRoomContext();
  const [state, setState] = useState<WbState>(null);
  const [collaborators, setCollaborators] = useState<Map<string, WbCollaborator>>(
    () => new Map(),
  );

  // Refs for everything the LiveKit handlers read, so they register once per
  // room and never re-subscribe — registerTextStreamHandler throws on a second
  // handler for the same topic.
  const stateRef = useRef<WbState>(null);
  const scene = useRef(new Map<string, WbElement>());
  const known = useRef(new Map<string, number>());
  const listeners = useRef(new Set<(elements: WbElement[]) => void>());
  const pending = useRef(new Map<string, WbElement>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef(0);
  const changedSinceSnapshot = useRef(false);
  const meRef = useRef(me);
  const canDrawRef = useRef(canDraw);
  useEffect(() => {
    meRef.current = me;
    canDrawRef.current = canDraw;
  }, [me, canDraw]);

  const commit = useCallback((next: WbState) => {
    const prev = stateRef.current;
    stateRef.current = next;
    if (!next || next.board !== prev?.board) {
      // A different board, or none: nothing of the last one carries over.
      scene.current = new Map();
      known.current = new Map();
      pending.current = new Map();
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      setCollaborators(new Map());
    }
    setState(next);
  }, []);

  // ------------------------------------------------------------------ send

  const sendText = useCallback(
    async (msg: WbMessage, to?: string[]) => {
      if (!canDrawRef.current) return;
      const local = room.localParticipant;
      if (!local) return;
      try {
        await local.sendText(JSON.stringify(msg), {
          topic: WB_TOPIC,
          ...(to ? { destinationIdentities: to } : {}),
        });
      } catch {
        // A dropped scene is repaired by the next snapshot; nothing to tell
        // anyone about.
      }
    },
    [room],
  );

  const sendFull = useCallback(
    (to?: string[]) => {
      const s = stateRef.current;
      if (!s) return;
      changedSinceSnapshot.current = false;
      void sendText(
        { k: "scene", board: s.board, full: true, elements: [...scene.current.values()] },
        to,
      );
    },
    [sendText],
  );

  const flush = useCallback(() => {
    flushTimer.current = null;
    const s = stateRef.current;
    if (!s || pending.current.size === 0) return;
    const elements = [...pending.current.values()];
    pending.current = new Map();
    void sendText({ k: "scene", board: s.board, full: false, elements });
  }, [sendText]);

  // --------------------------------------------------------------- receive

  const sender = useCallback(
    (identity: string): RemoteParticipant | undefined => room.remoteParticipants.get(identity),
    [room],
  );

  useEffect(() => {
    const onScene = (reader: { readAll: () => Promise<string> }, info: { identity: string }) => {
      const from = sender(info.identity);
      // Only the host and scheduled panelists are believed — see mayDraw.
      if (!from || !mayDraw(from.metadata)) return;
      void reader
        .readAll()
        .then((text) => {
          const msg = decodeWb(text);
          if (!msg) return;
          const next = reduceWb(stateRef.current, msg, from.identity, from.name || from.identity);
          if (next !== stateRef.current) commit(next);
          if (msg.k !== "scene" || next?.board !== msg.board) return;
          noteKnown(msg.elements, known.current);
          if (mergeInto(scene.current, msg.elements)) {
            for (const fn of listeners.current) fn(msg.elements);
          }
        })
        .catch(() => {});
    };
    room.registerTextStreamHandler(WB_TOPIC, onScene);
    return () => room.unregisterTextStreamHandler(WB_TOPIC);
  }, [room, sender, commit]);

  useEffect(() => {
    const onData = (payload: Uint8Array, p?: Participant, _k?: unknown, topic?: string) => {
      if (topic !== WB_POINTER_TOPIC || !p || !mayDraw(p.metadata)) return;
      const s = stateRef.current;
      const ptr: WbPointer | null = decodePointer(decoder.decode(payload));
      if (!s || !ptr || ptr.board !== s.board) return;
      setCollaborators((current) => {
        const next = new Map(current);
        next.set(p.identity, {
          name: ptr.name || p.name || p.identity,
          pointer: { x: ptr.x, y: ptr.y, tool: ptr.tool },
          button: ptr.button,
        });
        return next;
      });
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  /* Arrivals and departures.
   *
   * Somebody who connects mid-board gets the whole thing straight away from the
   * board's owner, rather than waiting for the next snapshot. The owner leaving
   * closes the board here — and if that was a dropped connection, the owner's own
   * next snapshot reopens it for everyone (reduceWb), so a blip is not the end. */
  useEffect(() => {
    const onJoin = (p: RemoteParticipant) => {
      const s = stateRef.current;
      if (s && s.owner === meRef.current.identity) sendFull([p.identity]);
    };
    const onLeave = (p: RemoteParticipant) => {
      const s = stateRef.current;
      if (s && s.owner === p.identity) commit(null);
      setCollaborators((current) => {
        if (!current.has(p.identity)) return current;
        const next = new Map(current);
        next.delete(p.identity);
        return next;
      });
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room, sendFull, commit]);

  /* The owner's snapshot: what a hidden attendee, whose arrival nobody's client
   * is told about, catches up from. Only when something changed — an idle board
   * is not re-sent to the whole room every few seconds — and otherwise every
   * fourth tick, so a late arrival is never left waiting long. */
  const isOwner = !!state && state.owner === me.identity;
  useEffect(() => {
    if (!isOwner) return;
    let tick = 0;
    const id = setInterval(() => {
      tick += 1;
      if (changedSinceSnapshot.current || tick % 4 === 0) sendFull();
    }, WB_SNAPSHOT_MS);
    return () => clearInterval(id);
  }, [isOwner, sendFull]);

  // Leaving the room with a board open closes it for everyone, rather than
  // leaving the audience looking at a board nobody can close.
  useEffect(
    () => () => {
      const s = stateRef.current;
      if (s && s.owner === meRef.current.identity && canDrawRef.current) {
        void room.localParticipant
          ?.sendText(JSON.stringify({ k: "close", board: s.board }), { topic: WB_TOPIC })
          .catch(() => {});
      }
    },
    [room],
  );

  // --------------------------------------------------------------- actions

  const open = useCallback(() => {
    if (!canDrawRef.current || stateRef.current) return;
    const board = newBoardId();
    const name = meRef.current.name;
    commit({ board, owner: meRef.current.identity, ownerName: name });
    void sendText({ k: "open", board, name });
  }, [commit, sendText]);

  const close = useCallback(() => {
    const s = stateRef.current;
    if (!canDrawRef.current || !s) return;
    void sendText({ k: "close", board: s.board });
    commit(null);
  }, [commit, sendText]);

  const toggle = useCallback(() => {
    if (stateRef.current) close();
    else open();
  }, [open, close]);

  const link = useMemo<WbCanvasLink>(
    () => ({
      elements: () => [...scene.current.values()],
      onRemote: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
      localChange: (elements) => {
        if (!canDrawRef.current || !stateRef.current) return;
        const fresh = unsent(elements, known.current);
        if (fresh.length === 0) return;
        mergeInto(scene.current, fresh);
        changedSinceSnapshot.current = true;
        for (const e of fresh) pending.current.set(e.id, e);
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, WB_SEND_THROTTLE_MS);
      },
      localPointer: (p) => {
        const s = stateRef.current;
        if (!canDrawRef.current || !s) return;
        const now = Date.now();
        if (now - lastPointer.current < WB_POINTER_THROTTLE_MS && p.button === "up") return;
        lastPointer.current = now;
        const msg: WbPointer = { k: "ptr", board: s.board, name: meRef.current.name, ...p };
        void room.localParticipant
          ?.publishData(encoder.encode(JSON.stringify(msg)), {
            reliable: false,
            topic: WB_POINTER_TOPIC,
          })
          .catch(() => {});
      },
    }),
    [room, flush],
  );

  const api = useMemo<WhiteboardApi>(
    () => ({ canDraw, state, isOwner, open, close, toggle, collaborators, link }),
    [canDraw, state, isOwner, open, close, toggle, collaborators, link],
  );

  return <WhiteboardContext.Provider value={api}>{children}</WhiteboardContext.Provider>;
}
