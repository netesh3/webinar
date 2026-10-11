"use client";

import { createPortal } from "react-dom";
import type { ToolId } from "@/lib/tools";
import { DockIcon } from "../icons";
import { ChatPanel } from "./chat-panel";
import { useRoomUI } from "./context";
import { ParticipantsPanel } from "./participants";
import { PollsPanel } from "./polls-panel";
import { QAPanel } from "./qa-panel";
import { RaisedHandsPopout } from "./raised-hands-panel";
import { tool } from "./tools";

/* Engagement tools rendered into their own browser windows (lib/popout.ts).
 *
 * A portal per window, from inside the room's tree, so each panel keeps every
 * context it has in the dock — the same realtime connection, the same roster,
 * the same unread counters. The popup itself is an empty document; all it
 * holds is what this draws into it.
 */

function Body({ id }: { id: ToolId }) {
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

export function PopoutWindows() {
  const { tools } = useRoomUI();
  return (
    <>
      <RaisedHandsPopout />
      {tools.popouts.map((p) =>
        createPortal(
          <div className="flex h-full min-h-0 flex-col bg-surface">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
              <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                {tool(p.tool).title}
              </h1>
              <button
                type="button"
                onClick={() => tools.popIn(p.tool)}
                title="Back to the meeting window"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <DockIcon className="size-4" />
                Back to meeting
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <Body id={p.tool} />
            </div>
          </div>,
          p.root,
          p.tool,
        ),
      )}
    </>
  );
}
