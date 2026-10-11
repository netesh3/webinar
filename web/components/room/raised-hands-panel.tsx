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
import { createPortal } from "react-dom";
import type { LiveParticipant } from "@/lib/api-types";
import { COMPACT_STAGE_HEIGHT, useCompact } from "@/lib/compact";
import { openPopout, type PopoutHandle } from "@/lib/popout";
import {
  beginRaisedHands,
  dismissRaisedHands,
  endRaisedHands,
  handAlreadyOnStage,
  inviteHandToSpeak,
  lowerAllHands,
  lowerOneHand,
  orderedRaisedHands,
  raisedAgoLabel,
} from "@/lib/raised-hands";
import type { ToolId } from "@/lib/tools";
import { Spinner } from "../controls";
import { ChatIcon, CloseIcon, DockIcon, PopOutIcon } from "../icons";
import { useToast } from "../providers";
import { SenderAvatar } from "../sender-avatar";
import { useRoomUI } from "./context";
import { setStageSettlingHand } from "./participants";

/* Host and panelist queue.
 *
 * Not a toolbar tool. The room has one docked drawer (`tools.panelTab`), so
 * this occupies that same slot while it is open and puts the previous tab
 * back on close. It is not a ToolId: pinning, dragging and the More grid's
 * customize path never see it. Chat, Participants, Q&A and Polls still open
 * through the tool layout; if one of them opens while this is up, this yields
 * and does not restore over it.
 */

export type ChatMentionSeed = { identity: string; name: string; nonce: number };

export type RaisedHandsApi = {
  open: boolean;
  chatMention: ChatMentionSeed | null;
  toggle: () => void;
  close: () => void;
  /** Shut the queue without putting the covered panel back. */
  dismiss: () => void;
  /** Open room chat addressed to this person. There is no direct-message thread. */
  messagePerson: (identity: string, name: string) => void;
  /** The queue lives in its own browser window right now (lib/popout.ts). */
  poppedOut: boolean;
  /** Where that window's portal renders, or null. */
  popoutRoot: HTMLElement | null;
  /** Move the queue into its own browser window. Call from a click — the
   *  popup blocker needs the gesture. False when the browser blocked it. */
  popOut: () => boolean;
  /** Bring it back into the docked drawer. */
  popIn: () => void;
};

const CLOSED: RaisedHandsApi = {
  open: false,
  chatMention: null,
  toggle: () => undefined,
  close: () => undefined,
  dismiss: () => undefined,
  messagePerson: () => undefined,
  poppedOut: false,
  popoutRoot: null,
  popOut: () => false,
  popIn: () => undefined,
};

const RaisedHandsContext = createContext<RaisedHandsApi | null>(null);

export function RaisedHandsProvider({
  value,
  children,
}: {
  value: RaisedHandsApi;
  children: ReactNode;
}) {
  return <RaisedHandsContext.Provider value={value}>{children}</RaisedHandsContext.Provider>;
}

export function useRaisedHandsPanel(): RaisedHandsApi {
  return useContext(RaisedHandsContext) ?? CLOSED;
}

export function useRaisedHandsController(tools: {
  panelTab: ToolId | null;
  open: (tool: ToolId) => void;
  closePanel: () => void;
}): RaisedHandsApi {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const restoreRef = useRef<ToolId | null>(null);
  const toolsRef = useRef(tools);
  useEffect(() => {
    toolsRef.current = tools;
  });
  const [chatMention, setChatMention] = useState<ChatMentionSeed | null>(null);
  /* The queue in its own browser window. Same shape as ToolApi.popOut, kept
   * here because the queue is not a ToolId. */
  const popoutRef = useRef<PopoutHandle | null>(null);
  const [popoutRoot, setPopoutRoot] = useState<HTMLElement | null>(null);

  const mentionNonce = useRef(0);

  const setOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  }, []);

  const close = useCallback(() => {
    const ended = endRaisedHands({ open: openRef.current, restore: restoreRef.current });
    restoreRef.current = null;
    setOpen(false);
    if (ended.restore) toolsRef.current.open(ended.restore as ToolId);
  }, [setOpen]);

  const dismiss = useCallback(() => {
    dismissRaisedHands();
    restoreRef.current = null;
    setOpen(false);
  }, [setOpen]);

  const toggle = useCallback(() => {
    // In its own window: the bar button closes it, as it does for Chat.
    if (popoutRef.current) {
      const handle = popoutRef.current;
      popoutRef.current = null;
      setPopoutRoot(null);
      handle.close();
      return;
    }
    if (openRef.current) {
      close();
      return;
    }
    const begun = beginRaisedHands(toolsRef.current.panelTab);
    restoreRef.current = begun.restore as ToolId | null;
    if (begun.restore) toolsRef.current.closePanel();
    setOpen(true);
  }, [close, setOpen]);

  const popOut = useCallback(() => {
    if (popoutRef.current) {
      popoutRef.current.win.focus();
      return true;
    }
    const handle: PopoutHandle | null = openPopout({
      name: "raised-hands",
      title: "Raised hands",
      // Closing the OS window puts the queue back in the drawer.
      onClosed: () => {
        if (popoutRef.current !== handle) return;
        popoutRef.current = null;
        setPopoutRoot(null);
        const begun = beginRaisedHands(toolsRef.current.panelTab);
        restoreRef.current = begun.restore as ToolId | null;
        if (begun.restore) toolsRef.current.closePanel();
        setOpen(true);
      },
    });
    if (!handle) return false;
    popoutRef.current = handle;
    setPopoutRoot(handle.root);
    // Out of the drawer, putting back whatever it covered (or nothing, which
    // gives the video its full width).
    if (openRef.current) close();
    return true;
  }, [close, setOpen]);

  const popIn = useCallback(() => {
    const handle = popoutRef.current;
    if (!handle) return;
    popoutRef.current = null;
    setPopoutRoot(null);
    handle.close();
    const begun = beginRaisedHands(toolsRef.current.panelTab);
    restoreRef.current = begun.restore as ToolId | null;
    if (begun.restore) toolsRef.current.closePanel();
    setOpen(true);
  }, [setOpen]);

  // Leaving the room (or reloading) closes the window with it.
  useEffect(() => {
    const closeIt = () => {
      popoutRef.current?.close();
      popoutRef.current = null;
    };
    window.addEventListener("pagehide", closeIt);
    return () => {
      window.removeEventListener("pagehide", closeIt);
      closeIt();
    };
  }, []);

  const messagePerson = useCallback(
    (identity: string, name: string) => {
      dismissRaisedHands();
      restoreRef.current = null;
      setOpen(false);
      mentionNonce.current += 1;
      setChatMention({ identity, name, nonce: mentionNonce.current });
      toolsRef.current.open("chat");
    },
    [setOpen],
  );

  // A docked tool opened underneath this drawer replaces it. The null tab we
  // wrote ourselves on open does not.
  const panelTab = tools.panelTab;
  useEffect(() => {
    if (!openRef.current || !panelTab) return;
    restoreRef.current = null;
    setOpen(false);
  }, [panelTab, setOpen]);

  return useMemo(
    () => ({
      open,
      chatMention,
      toggle,
      close,
      dismiss,
      messagePerson,
      poppedOut: popoutRoot !== null,
      popoutRoot,
      popOut,
      popIn,
    }),
    [open, chatMention, toggle, close, dismiss, messagePerson, popoutRoot, popOut, popIn],
  );
}

/** The queue in its own browser window. Renders nothing until popped out. */
export function RaisedHandsPopout() {
  const raised = useRaisedHandsPanel();
  if (!raised.popoutRoot) return null;
  return createPortal(<RaisedHandsDrawer variant="window" />, raised.popoutRoot);
}

export function RaisedHandsDrawer({ variant = "dock" }: { variant?: "dock" | "window" } = {}) {
  const inWindow = variant === "window";
  const { slug, realtime, roster } = useRoomUI();
  const raised = useRaisedHandsPanel();
  const compact = useCompact();
  const { notify } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  const hands = useMemo(() => orderedRaisedHands(realtime.hands), [realtime.hands]);
  const byIdentity = useMemo(() => {
    const map = new Map<string, LiveParticipant>();
    for (const person of roster.live?.participants ?? []) map.set(person.identity, person);
    return map;
  }, [roster.live]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const close = raised.close;
  useEffect(() => {
    // Escape belongs to the room window; the popup has its own close button.
    if (inWindow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, inWindow]);

  const run = useCallback(
    async (key: string, work: () => Promise<void>) => {
      setBusy(key);
      try {
        await work();
      } catch (err) {
        notify(err instanceof Error ? err.message : "That didn't work.", "error");
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );

  return (
    <aside
      className={`room-dark flex flex-col bg-surface ${
        inWindow
          ? "h-full min-h-0"
          : compact
            ? "absolute inset-x-0 bottom-0 z-40 shadow-2xl"
            : "absolute inset-y-0 right-0 z-40 w-[22.5rem] max-w-full overflow-hidden border-l border-line shadow-2xl"
      }`}
      style={!inWindow && compact ? { top: COMPACT_STAGE_HEIGHT } : undefined}
      role="complementary"
      aria-label={`Raised hands (${hands.length})`}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          Raised hands ({hands.length})
        </h2>
        <button
          type="button"
          onClick={() => {
            const count = hands.length;
            void run("all", async () => {
              await lowerAllHands(realtime.clearHands);
              notify(`Lowered ${count} ${count === 1 ? "hand" : "hands"}.`, "ok");
            });
          }}
          disabled={busy !== null || hands.length === 0}
          className="shrink-0 rounded-md px-2 py-1 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand/10 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {busy === "all" ? "Lowering…" : "Lower all"}
        </button>
        {inWindow ? (
          <button
            type="button"
            onClick={() => raised.popIn()}
            title="Back to the meeting window"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <DockIcon className="size-4" />
            Back to meeting
          </button>
        ) : (
          <>
            {!compact && (
              <button
                type="button"
                onClick={() => {
                  // Straight from the click: window.open needs the gesture.
                  if (!raised.popOut()) {
                    notify(
                      "Your browser blocked the new window. Allow pop-ups for this site and try again.",
                      "error",
                    );
                  }
                }}
                aria-label="Open raised hands in a new window"
                title="Open in a new window (move it to another screen)"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <PopOutIcon className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => raised.close()}
              aria-label="Close panel"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <CloseIcon className="size-4" />
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hands.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
            No hands raised.
          </p>
        ) : (
          <ol>
            {hands.map((hand, index) => {
              const person = byIdentity.get(hand.identity);
              const name = person?.name || hand.name || "Someone";
              const ago = raisedAgoLabel(hand.at, now);
              const onStage = handAlreadyOnStage(person);
              const rowBusy = busy === hand.identity;
              return (
                <li key={hand.identity} className="border-b border-line px-3 py-3">
                  <div className="flex gap-2.5">
                    <span className="w-4 shrink-0 pt-2 text-center text-[13px] font-medium tabular-nums text-ink-3">
                      {index + 1}
                    </span>
                    <SenderAvatar name={name} identity={hand.identity} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-ink">{name}</p>
                      {ago && <p className="text-[12px] text-ink-3">{ago}</p>}
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy !== null || onStage}
                          title={onStage ? "Already on stage" : `Invite ${name} to speak`}
                          onClick={() => {
                            void run(hand.identity, async () => {
                              const outcome = await inviteHandToSpeak(setStageSettlingHand, {
                                slug,
                                lowerHand: realtime.lowerHand,
                                identity: hand.identity,
                                alreadyOnStage: onStage,
                              });
                              if (outcome === "skipped") return;
                              notify(`Waiting for ${name} to accept`, "ok");
                              await roster.reload();
                            });
                          }}
                          className="inline-flex h-8 min-w-0 flex-1 items-center justify-center rounded-lg bg-brand px-2.5 text-[12px] font-medium text-stage transition-colors hover:bg-brand-hover disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          {rowBusy ? <Spinner className="size-3.5" /> : "Invite to speak"}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            void run(hand.identity, async () => {
                              await lowerOneHand(realtime.lowerHand, hand.identity);
                              notify(`Dismissed ${name}'s request`, "ok");
                            });
                          }}
                          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-line-2 px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          Lower hand
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          aria-label={`Message ${name}`}
                          title={`Message ${name}`}
                          onClick={() => raised.messagePerson(hand.identity, name)}
                          className="grid size-8 shrink-0 place-items-center rounded-full border border-line-2 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <ChatIcon className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
