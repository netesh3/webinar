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

/* Docked engagement panel — one vertical rail, one content surface.
 *
 * Chat / Q&A / Polls / Participants share a single icon rail (Zoom/Teams-like).
 * No second horizontal tab strip — that duplicated the control-bar pins and
 * forced an ugly overflow scrollbar. The rail is always present; opening a tool
 * expands the content pane beside it. Pop out undocks into a floating window.
 * Host / Settings / Invite stay windows-only.
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

  const railTools = useMemo(
    () => PANEL_TOOL_IDS.filter((id) => availableTools.includes(id)),
    [availableTools],
  );

  /** Tools still available to dock (not already floating). */
  const dockable = useMemo(
    () => railTools.filter((id) => !tools.layout.windows[id]),
    [railTools, tools.layout.windows],
  );

  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tools.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, tools]);

  // Active tab undocked or unavailable → pick another dockable tool or close.
  useEffect(() => {
    if (!tab) return;
    if (dockable.includes(tab)) return;
    if (dockable.length === 0) tools.closePanel();
    else tools.open(dockable[0]);
  }, [tab, dockable, tools]);

  if (railTools.length === 0) return null;

  const active =
    tab && dockable.includes(tab) ? tab : tab && dockable.length ? dockable[0] : null;
  const open = active !== null && tab !== null;

  const badgeFor = (id: ToolId): number => {
    if (id === "participants" && isHost && realtime.hands.length > 0) {
      return realtime.hands.length;
    }
    return unread[id] ?? 0;
  };

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => tools.closePanel()}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}

      <div
        className={`z-40 flex shrink-0 ${
          open
            ? "absolute inset-x-0 bottom-0 top-0 md:static md:inset-auto"
            : "relative"
        }`}
      >
        {/* Content pane — only when a docked tool is active. */}
        {open && active && (
          <aside
            className="room-dark flex min-w-0 flex-1 flex-col border-l border-line bg-surface shadow-2xl md:w-[320px] md:flex-none md:shadow-none"
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
        )}

        {/* Single engagement rail — the only switcher for these tools. */}
        <nav
          aria-label="Session tools"
          className="room-dark flex w-12 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface py-2"
        >
          {railTools.map((id) => {
            const t = tool(id);
            const Icon = t.icon;
            const selected = open && active === id;
            const floating = Boolean(tools.layout.windows[id]);
            const badge = badgeFor(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (selected) tools.closePanel();
                  else tools.open(id);
                }}
                aria-label={t.title}
                aria-pressed={selected}
                title={floating ? `${t.label} (popped out)` : t.label}
                className={`relative grid size-9 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  selected
                    ? "bg-brand-soft text-brand"
                    : floating
                      ? "text-ink-3 hover:bg-surface-2 hover:text-ink"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <Icon className="size-5" />
                {badge > 0 && !selected && (
                  <span className="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-brand px-0.5 text-[9px] font-semibold text-white">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
}
