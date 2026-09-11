"use client";

import { useMemo } from "react";
import { isPanelTool, type ToolId } from "@/lib/tools";
import { useCompact } from "@/lib/compact";
import { DockIcon } from "../icons";
import { ChatPanel } from "./chat-panel";
import { useRoomUI } from "./context";
import { DeviceSettings } from "./device-settings";
import { FloatingWindow } from "./floating-window";
import { HostControls } from "./host-controls";
import { ParticipantsPanel } from "./participants";
import { PollsPanel } from "./polls-panel";
import { QAPanel } from "./qa-panel";
import { tool } from "./tools";

/* Floating tool windows — Host tools, Settings, Invite, plus any engagement
 * tool the user has popped out of the docked SidePanel.
 *
 * Undocked Chat / Q&A / Polls / Participants use the same chrome so they can be
 * dragged across the stage (and onto another monitor when the browser spans both).
 */

function Content({ id }: { id: ToolId }) {
  switch (id) {
    case "chat":
      return <ChatPanel />;
    case "qa":
      return <QAPanel />;
    case "polls":
      return <PollsPanel />;
    case "participants":
      return <ParticipantsPanel />;
    case "settings":
      return <DeviceSettings />;
    case "host":
      return <HostControls />;
    // Reactions, raise-hand, layout and invite act immediately (or open their
    // own anchored popover) and never open a floating window. Listed rather
    // than defaulted, so adding a tool without deciding this is a type error
    // instead of a blank window.
    case "reactions":
    case "hand":
    case "layout":
    case "invite":
      return null;
  }
}

export function ToolWindows() {
  const { tools, unread } = useRoomUI();
  const compact = useCompact();

  /* Sorted by stacking order, so the DOM order matches the visual order.
   *
   * z-index does the real work, but a screen reader reads the DOM, and the window
   * on top being announced last is a window nobody finds. Sorting by tool id
   * would have been stable across renders and wrong for exactly that reason. */
  const open = useMemo(
    () => Object.values(tools.layout.windows).sort((a, b) => a.z - b.z),
    [tools.layout.windows],
  );

  if (open.length === 0) return null;

  const top = open[open.length - 1];

  // Collapsed: minimised by the user, or — on a phone, where only one window fits
  // — open but not the one on top.
  const collapsed = open.map(
    (win) => win.minimized || (compact && win.tool !== top.tool),
  );
  let stack = 0;

  return (
    <>
      {open.map((win, i) => {
        const t = tool(win.tool);
        const index = collapsed[i] ? stack++ : 0;
        const canDock = isPanelTool(win.tool) && !compact;
        return (
          <FloatingWindow
            key={win.tool}
            win={win}
            title={t.title}
            icon={t.icon}
            // Not the same as being on top: a collapsed window is never focused,
            // or Escape would close the strip the user just minimised.
            focused={win.tool === top.tool && !collapsed[i]}
            compact={compact}
            collapsed={collapsed[i]}
            collapsedIndex={index}
            level={i}
            badge={unread[win.tool]}
            keepMounted={t.keepMounted}
            onFocus={() => tools.focus(win.tool)}
            onMove={(rect) => tools.move(win.tool, rect)}
            // On a phone, un-collapsing means "bring to the front", which is what
            // open() does — the window is not minimised, it is just underneath.
            onMinimize={() =>
              compact && !win.minimized
                ? tools.open(win.tool)
                : tools.minimize(win.tool, !win.minimized)
            }
            onMaximize={() => tools.maximize(win.tool)}
            onClose={() => tools.close(win.tool)}
            actions={
              canDock ? (
                <TitleDock
                  title={t.title}
                  onDock={() => tools.dock(win.tool)}
                />
              ) : undefined
            }
          >
            <Content id={win.tool} />
          </FloatingWindow>
        );
      })}
    </>
  );
}

function TitleDock({ title, onDock }: { title: string; onDock: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Dock ${title}`}
      title="Dock in side panel"
      onClick={onDock}
      className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors outline-none hover:bg-surface-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <DockIcon className="size-3.5" />
    </button>
  );
}
