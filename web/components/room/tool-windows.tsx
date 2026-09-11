"use client";

import { useEffect, useMemo, useState } from "react";
import type { ToolId } from "@/lib/tools";
import { isPanelTool } from "@/lib/tools";
import { ChatPanel } from "./chat-panel";
import { useRoomUI } from "./context";
import { DeviceSettings } from "./device-settings";
import { FloatingWindow } from "./floating-window";
import { HostControls } from "./host-controls";
import { InvitePanel } from "./invite-panel";
import { ParticipantsPanel } from "./participants";
import { PollsPanel } from "./polls-panel";
import { QAPanel } from "./qa-panel";
import { tool } from "./tools";

/* Floating tool windows — Host tools, Settings, Invite.
 *
 * Chat / Q&A / Polls / Participants live in the docked SidePanel instead. The
 * Content switch still knows those ids so a stray window state from an older
 * session can render if somehow present; ToolWindows filters them out. */

/** `md`, matching the class the room's own layout switches at, so the sheet
 *  appears exactly when the stage stops having room beside it. */
const COMPACT_QUERY = "(max-width: 767px)";

function useCompact(): boolean {
  // False for the server render and the first client render, then the truth.
  // Sniffing a user agent would be wrong on a narrow desktop window, which is the
  // case this actually has to get right.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return compact;
}

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
    case "invite":
      return <InvitePanel />;
    case "settings":
      return <DeviceSettings />;
    case "host":
      return <HostControls />;
    // Reactions, raise-hand, and layout act immediately and never open a window.
    // Listed rather than defaulted, so adding a tool without deciding this is a type
    // error instead of a blank window.
    case "reactions":
    case "hand":
    case "layout":
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
    () =>
      Object.values(tools.layout.windows)
        .filter((win) => !isPanelTool(win.tool))
        .sort((a, b) => a.z - b.z),
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
          >
            <Content id={win.tool} />
          </FloatingWindow>
        );
      })}
    </>
  );
}
