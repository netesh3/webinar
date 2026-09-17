"use client";

import { useEffect, useMemo } from "react";
import { PANEL_TOOL_IDS, type ToolId } from "@/lib/tools";
import { COMPACT_STAGE_HEIGHT, useCompact } from "@/lib/compact";
import { CloseIcon, PopOutIcon } from "../icons";
import { ChatPanel } from "./chat-panel";
import { useRoomUI } from "./context";
import { ParticipantsPanel } from "./participants";
import { PollsPanel } from "./polls-panel";
import { QAPanel } from "./qa-panel";
import { tool } from "./tools";

/* Engagement panel — Zoom's Chat / Q&A / Participants card.
 *
 * Opening a tool used to shrink the video and grow a permanent icon rail down
 * the right edge. Zoom does neither: on desktop the stage stays full-bleed
 * and this sits over it as a right-hand overlay, opened from the bottom bar.
 * On a phone-shaped viewport it docks instead of overlaying — the video
 * keeps a fixed strip at the top (see COMPACT_STAGE_HEIGHT / webinar-room.tsx)
 * and this panel takes the remaining space below it, because a full-screen
 * takeover on a screen that small reads as "the video is gone", not "there's
 * a panel over the video". Pop out still undocks into a floating window on
 * either size. There is no rail — those buttons live in the control bar.
 */

function PanelBody({ id }: { id: ToolId }) {
  switch (id) {
    case "chat":
      return <ChatPanel />;
    case "qa":
      return <QAPanel />;
    case "polls":
      return <PollsPanel />;
    case "participants":
      return <ParticipantsPanel />;
    default:
      return null;
  }
}

export function SidePanel() {
  const { tools, availableTools } = useRoomUI();
  const compact = useCompact();
  const tab = tools.panelTab;

  const dockable = useMemo(
    () =>
      PANEL_TOOL_IDS.filter(
        (id) => availableTools.includes(id) && !tools.layout.windows[id],
      ),
    [availableTools, tools.layout.windows],
  );

  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tools.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, tools]);

  useEffect(() => {
    if (!tab) return;
    if (dockable.includes(tab)) return;
    if (dockable.length === 0) tools.closePanel();
    else tools.open(dockable[0]);
  }, [tab, dockable, tools]);

  const active = tab && dockable.includes(tab) ? tab : null;
  if (!active) return null;

  return (
    <>
      {/* No backdrop on compact: the panel used to float over the whole
          screen with the video darkened behind it, and tapping the dimmed
          video was how you closed it. Now the video keeps its own visible
          strip at the top and the panel only occupies the space below —
          nothing left to dim, and nothing "outside" the panel to tap; the
          panel's own close button (below) is the way out. */}
      <aside
        className={`room-dark z-40 flex flex-col bg-surface shadow-2xl ${
          compact
            ? "absolute inset-x-0 bottom-0"
            : "absolute inset-y-0 right-0 w-[22.5rem] max-w-full overflow-hidden border-l border-line"
        }`}
        style={compact ? { top: COMPACT_STAGE_HEIGHT } : undefined}
        role="complementary"
        aria-label={tool(active).title}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {tool(active).title}
          </h2>
          <button
            type="button"
            onClick={() => tools.undock(active)}
            aria-label={`Pop out ${tool(active).title}`}
            title="Pop out"
            className="hidden size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:grid"
          >
            <PopOutIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => tools.closePanel()}
            aria-label="Close panel"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelBody id={active} />
        </div>
      </aside>
    </>
  );
}
