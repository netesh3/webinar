"use client";

import { useEffect, useMemo } from "react";
import { PANEL_TOOL_IDS, type ToolId } from "@/lib/tools";
import { CloseIcon, PopOutIcon } from "../icons";
import { ChatPanel } from "./chat-panel";
import { useRoomUI } from "./context";
import { ParticipantsPanel } from "./participants";
import { PollsPanel } from "./polls-panel";
import { QAPanel } from "./qa-panel";
import { tool } from "./tools";

/* Docked engagement panel — one side surface with tabs.
 *
 * Default home for Chat / Q&A / Polls / Participants (Zoom/Livestorm pattern).
 * Pop out undocks the active tab into a floating window so it can sit beside the
 * stage — or be dragged onto another monitor when the browser window spans both.
 * Host tools, Settings and Invite stay windows-only.
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
  const { tools, availableTools, unread, realtime, isHost } = useRoomUI();
  const tab = tools.panelTab;

  const tabs = useMemo(
    () =>
      PANEL_TOOL_IDS.filter(
        (id) => availableTools.includes(id) && !tools.layout.windows[id],
      ),
    [availableTools, tools.layout.windows],
  );

  // Escape closes the panel when no floating window is focused on top of it.
  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tools.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, tools]);

  // If the active tab was undocked (or became unavailable), drop it so unread
  // watermarks and the tab strip stay honest.
  useEffect(() => {
    if (!tab) return;
    if (tabs.includes(tab)) return;
    if (tabs.length === 0) tools.closePanel();
    else tools.open(tabs[0]);
  }, [tab, tabs, tools]);

  if (!tab || tabs.length === 0) return null;

  const active = tabs.includes(tab) ? tab : tabs[0];

  const badgeFor = (id: ToolId): number => {
    if (id === "participants" && isHost && realtime.hands.length > 0) {
      return realtime.hands.length;
    }
    return unread[id] ?? 0;
  };

  return (
    <>
      {/* Mobile: dim the stage so the panel reads as the primary surface. */}
      <button
        type="button"
        aria-label="Close panel"
        onClick={() => tools.closePanel()}
        className="absolute inset-0 z-30 bg-black/50 md:hidden"
      />

      <aside
        className="room-dark absolute inset-x-0 bottom-0 top-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-2xl md:static md:z-auto md:w-[360px] md:shrink-0 md:shadow-none"
        role="complementary"
        aria-label="Session panel"
      >
        <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {tabs.map((id) => {
              const t = tool(id);
              const selected = id === active;
              const badge = badgeFor(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => tools.open(id)}
                  aria-pressed={selected}
                  className={`relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    selected
                      ? "bg-brand-soft text-brand"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  {t.label}
                  {badge > 0 && !selected && (
                    <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {/* Desktop only: phone sheets already fill the viewport; undocking there
              stacks another sheet on top of the rail with nowhere useful to go. */}
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
