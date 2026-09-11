"use client";

import { useEffect, useRef, useState } from "react";
import type { ToolId } from "@/lib/tools";
import { LAYOUT_LABEL } from "@/lib/layout";
import { useCompact } from "@/lib/compact";
import { GridIcon, PinIcon } from "../icons";
import { useRoomUI } from "./context";
import { InviteMenu } from "./invite-panel";
import { LayoutMenu } from "./layout-menu";
import { ReactionPicker } from "./reactions";
import { useToolDrag } from "./tool-drag";
import { tool } from "./tools";

/* The "More" overflow grid — media/session extras only.
 *
 * Chat / Q&A / Polls / Participants are NOT here; they live on the right-edge
 * engagement rail. This grid holds Invite, Reactions, Hand, Settings, Host tools
 * and anything else the user unpinned from the bar.
 *
 * Every cell does double duty: click to open, drag to pin.
 *
 * Below `md` it is a bottom sheet instead of a card floating off the button —
 * same `compact` boundary and the same shape FloatingWindow already uses for a
 * tool window on a phone (lib/compact.ts), so the room has one mobile-sheet
 * convention rather than two slightly different ones. Dragging to pin still
 * works: touch-and-drag off a bar slot behaves the same either way, it is only
 * this panel's own position and backdrop that change.
 */

export function MoreGrid({
  items,
  onClose,
}: {
  items: readonly ToolId[];
  onClose: () => void;
}) {
  const { tools, unread, realtime, stage } = useRoomUI();
  const drag = useToolDrag();
  const dragging = drag.drag !== null;
  const compact = useCompact();
  const panel = useRef<HTMLDivElement | null>(null);
  /** The emoji row, revealed in place. Reactions are the one grid item that is
   *  not a window and not a single action — there are six of them — so it opens
   *  here rather than in a second popover stacked on this one. */
  const [showReactions, setShowReactions] = useState(false);
  /** Layout picker when Layout lives in More (user unpinned it from the bar). */
  const [showLayout, setShowLayout] = useState(false);
  /** Invite popover, revealed in place — same reasoning as Reactions: it opens
   *  right here rather than in a second popover stacked on this one. */
  const [showInvite, setShowInvite] = useState(false);

  /* Dismiss on Escape and on a press outside.
   *
   * A press, not a release: a drag that starts on a bar slot lands its release
   * over the grid, and closing on release would tear the drop target down at the
   * moment of the drop. Escape is also handled by the drag layer, which takes it
   * first while a drag is in flight — cancelling the drag rather than closing the
   * grid is the right response to the first Escape. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dragging) onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      // The More button itself is excluded so its own click can toggle rather
      // than closing here and immediately reopening.
      if ((e.target as HTMLElement).closest?.("[data-more-button]")) return;
      // A press on a bar slot is very likely the start of a drag whose target is
      // this grid. Closing it here would remove the target before the gesture had
      // a chance to use it.
      if ((e.target as HTMLElement).closest?.("[data-tool-slot]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, dragging]);

  const dropping = drag.drag?.over === "grid" && drag.drag.from === "bar";
  const inviting = drag.drag?.from === "bar" && !dropping;

  return (
    <>
      {/* The dimming backdrop, phone-only. On desktop the card floats off the
          button with nothing behind it — a full-screen scrim there would dim
          the stage for a tools popover no bigger than a dropdown. On a phone
          the sheet fills most of the screen, so it reads as a distinct layer
          the way it does in every native app. Not itself a click-to-close
          target: the existing outside-pointerdown listener already covers
          that (and has to, for the drag-to-pin exclusions above), so this is
          purely the visual cue. */}
      {compact && <div aria-hidden className="fixed inset-0 z-40 bg-black/50" />}
      <div
        ref={(el) => {
          panel.current = el;
          drag.setGrid(el);
        }}
        role="dialog"
        aria-modal={compact || undefined}
        aria-label="More tools"
        className={
          compact
            ? `room-dark fixed inset-x-0 bottom-0 z-50 max-h-[72dvh] overflow-y-auto rounded-t-2xl border-t bg-surface p-2 shadow-2xl transition-colors ${
                dropping
                  ? "border-live ring-2 ring-live/40"
                  : inviting
                    ? "border-dashed border-live/60"
                    : "border-line"
              }`
            : `room-dark absolute right-0 bottom-full z-50 mb-2 w-[336px] max-w-[calc(100vw-1rem)] rounded-xl border bg-surface p-2 shadow-2xl transition-colors ${
                dropping
                  ? "border-live ring-2 ring-live/40"
                  : // While a bar tool is in flight this grid is a live target, so it
                    // says so before the pointer arrives rather than only once it is
                    // over it.
                    inviting
                    ? "border-dashed border-live/60"
                    : "border-line"
              }`
        }
        // Clears the iOS home indicator on a phone, same reasoning as the
        // control bar itself — the sheet is pinned to the true bottom of the
        // viewport there, not floating above a button.
        style={
          compact
            ? { paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }
            : undefined
        }
      >
        {/* The grab-handle affordance a bottom sheet is recognised by. Purely
            visual — Escape, the backdrop area, and dragging a bar slot off the
            grid all already close it without this being interactive. */}
        {compact && (
          <div className="mb-1 flex justify-center">
            <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
          </div>
        )}

        <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1.5">
          <span
            className={`text-[11px] font-semibold tracking-[0.06em] uppercase ${
              dropping || inviting ? "text-live" : "text-ink-3"
            }`}
          >
            {dropping ? "Release to remove it" : inviting ? "Drop here to remove" : "Tools"}
          </span>
          {/* Hidden mid-drag: a destructive-looking button under the cursor at the
              moment of a drop is a mis-click waiting to happen. */}
          {!dragging && (
            <button
              type="button"
              onClick={() => {
                tools.reset();
                onClose();
              }}
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Reset layout
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="px-1.5 py-6 text-center text-[12.5px] text-ink-3">
            Everything is on the bar. Drag an item off it to put it back here.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            {items.map((id) => {
              const t = tool(id);
              const Icon = t.icon;
              const badge = unread[id];
              const active =
                id === "hand"
                  ? realtime.myHandRaised
                  : id === "reactions"
                    ? showReactions
                    : id === "layout"
                      ? showLayout
                      : id === "invite"
                        ? showInvite
                        : false;

              return (
                <button
                  key={id}
                  type="button"
                  data-tool-cell={id}
                  aria-label={t.title}
                  aria-pressed={active}
                  title={`${t.title} — drag to the bar to pin it`}
                  {...drag.bind(id, "grid", () => {
                    if (id === "reactions") {
                      setShowReactions((v) => !v);
                      setShowLayout(false);
                      setShowInvite(false);
                      return;
                    }
                    if (id === "invite") {
                      setShowInvite((v) => !v);
                      setShowReactions(false);
                      setShowLayout(false);
                      return;
                    }
                    if (id === "layout") {
                      setShowLayout((v) => !v);
                      setShowReactions(false);
                      setShowInvite(false);
                      tools.used("layout");
                      return;
                    }
                    if (id === "hand") {
                      void realtime.toggleHand();
                      onClose();
                      return;
                    }
                    tools.toggle(id);
                    onClose();
                  })}
                  className={`relative flex h-[76px] flex-col items-center justify-center gap-1.5 rounded-lg px-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    active
                      ? "bg-brand/15 text-brand"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  } ${drag.drag?.tool === id ? "opacity-40" : ""}`}
                >
                  <Icon className="size-[22px]" />
                  <span className="text-[11px] leading-tight font-medium">
                    {id === "layout" ? `Layout · ${LAYOUT_LABEL[stage.mode]}` : t.label}
                  </span>
                  {badge !== undefined && badge > 0 && (
                    <span className="absolute top-1.5 right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {showLayout && (
          <div className="relative mt-2 border-t border-line pt-2">
            <LayoutMenu onClose={() => setShowLayout(false)} embedded />
          </div>
        )}

        {showReactions && (
          <div className="mt-2 border-t border-line pt-2">
            <ReactionPicker
              onPick={(emoji) => {
                void realtime.react(emoji);
                tools.used("reactions");
                setShowReactions(false);
                onClose();
              }}
            />
          </div>
        )}

        {showInvite && (
          <div className="relative mt-2 border-t border-line pt-2">
            <InviteMenu
              embedded
              onUsed={() => tools.used("invite")}
              onClose={() => {
                setShowInvite(false);
                onClose();
              }}
            />
          </div>
        )}

        <p className="mt-2 flex items-center gap-1.5 border-t border-line px-1.5 pt-2 text-[11px] text-ink-3">
          <PinIcon className="size-3 shrink-0" />
          Chat, Q&amp;A, Polls, and Participants are on the right rail. Layout stays on the bar.
        </p>
      </div>
    </>
  );
}

/** The trigger. Separate so the bar can render it in its fixed tail alongside
 *  Leave, and so the grid's outside-click handler has something to recognise. */
export function MoreButton({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-more-button
      aria-label="More tools"
      aria-expanded={open}
      aria-haspopup="dialog"
      title="More tools"
      onClick={onToggle}
      className="relative shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/50"
    >
      <span
        className={`inline-flex h-10 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-2 transition-colors sm:min-w-14 ${
          open ? "bg-white/20 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"
        }`}
      >
        <GridIcon className="size-5" />
        <span className="hidden text-[9.5px] leading-none font-medium sm:block">More</span>
      </span>
      {count > 0 && (
        <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
