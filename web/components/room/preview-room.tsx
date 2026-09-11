"use client";

import { Room } from "livekit-client";
import { RoomContext } from "@livekit/components-react";
import { useEffect, useMemo, useState } from "react";
import {
  bypassRealtime,
  DEV_BYPASS_JOIN,
  DEV_BYPASS_LIVE,
  DEV_BYPASS_ME,
  DEV_BYPASS_NETWORK,
} from "@/lib/dev-bypass";
import { DEFAULT_PREFERENCES } from "@/lib/media";
import { useStageLayout } from "@/lib/layout";
import { useToolLayout, type ToolId } from "@/lib/tools";
import type { MediaPermissions } from "@/lib/permissions";
import type { FileShareApi } from "@/lib/file-share";
import { ControlBar } from "./control-bar";
import { RoomUIProvider, useRoomUI, type RoomUI } from "./context";
import { SidePanel } from "./side-panel";
import { ToolDragProvider } from "./tool-drag";
import { ToolWindows } from "./tool-windows";
import { useAvailableTools } from "./tools";

/* Dev-only room chrome: header, docked side panel, control bar — no LiveKit media. */

const HOST_PERMS: MediaPermissions = {
  canPublish: true,
  canSpeak: true,
  canShareCamera: true,
  // No LiveKit in the chrome preview — offering Share would open getDisplayMedia
  // and then fail to publish, which looks like "screenshare is broken".
  canShareScreen: false,
  audioOnly: false,
  mutedByHost: false,
  promoted: false,
};

const IDLE_FILE_SHARE: FileShareApi = {
  active: false,
  source: null,
  playing: false,
  position: 0,
  duration: 0,
  monitor: false,
  starting: false,
  error: null,
  start: async () => undefined,
  stop: async () => undefined,
  play: () => undefined,
  pause: () => undefined,
  seek: () => undefined,
  setMonitor: () => undefined,
};

const EMPTY_UNREAD: Record<ToolId, number> = {
  chat: 0,
  qa: 1,
  polls: 0,
  participants: 1,
  invite: 0,
  reactions: 0,
  hand: 0,
  layout: 0,
  settings: 0,
  host: 0,
};

export function PreviewRoom() {
  const room = useMemo(() => new Room(), []);
  const join = DEV_BYPASS_JOIN;
  const availableTools = useAvailableTools({
    isHost: true,
    controls: join.controls,
  });
  const tools = useToolLayout(availableTools);
  const stage = useStageLayout();
  const realtime = useMemo(() => bypassRealtime(), []);
  const [prefs, setPrefs] = useState(DEFAULT_PREFERENCES);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    tools.setStage(stageEl);
  }, [tools, stageEl]);

  useEffect(() => {
    tools.open("chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open panel once for review
  }, []);

  const ui = useMemo<RoomUI>(
    () => ({
      slug: "preview",
      join,
      controls: join.controls,
      topic: join.topic,
      startedAt: join.startedAt ?? null,
      endedAt: null,
      status: "live",
      recording: false,
      isHost: true,
      permissions: HOST_PERMS,
      me: DEV_BYPASS_ME,
      entryVideo: null,
      recovering: null,
      realtime,
      roster: {
        live: DEV_BYPASS_LIVE,
        error: false,
        reload: async () => undefined,
      },
      polls: {
        list: [],
        reload: () => undefined,
        replace: () => undefined,
      },
      network: DEV_BYPASS_NETWORK,
      tools,
      availableTools,
      unread: EMPTY_UNREAD,
      fileShare: IDLE_FILE_SHARE,
      stage,
      prefs,
      updatePrefs: (patch) => setPrefs((p) => ({ ...p, ...patch })),
      leave: () => {
        window.location.href = "/host";
      },
    }),
    [join, realtime, tools, availableTools, stage, prefs],
  );

  return (
    <RoomContext.Provider value={room}>
      <RoomUIProvider value={ui}>
        <ToolDragProvider onPin={tools.pin} onUnpin={tools.unpin}>
          <div data-room className="flex h-dvh flex-col overflow-hidden bg-stage">
            <PreviewHeader />
            <div className="relative flex min-h-0 min-w-0 flex-1">
              <div
                ref={setStageEl}
                className="relative flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <PreviewStage />
              </div>
              <SidePanel />
            </div>
            <ControlBar />
          </div>
          <ToolWindows />
        </ToolDragProvider>
      </RoomUIProvider>
    </RoomContext.Provider>
  );
}

function PreviewHeader() {
  const { topic, tools } = useRoomUI();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 bg-stage-bar px-3 text-white">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[13px] font-semibold">{topic}</h1>
          <span className="rounded-md bg-white/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
            Preview
          </span>
        </div>
        <p className="text-[11px] text-white/45">
          Local UI only — no LiveKit connection
        </p>
      </div>
      <button
        type="button"
        onClick={() => tools.open("chat")}
        className="rounded-md bg-white/10 px-2.5 py-1 text-[12px] hover:bg-white/15"
      >
        Open panel
      </button>
    </header>
  );
}

function PreviewStage() {
  const people = [
    { name: "Preview Host", role: "Host", hue: "210" },
    { name: "Alex Chen", role: "Panelist", hue: "160" },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 md:p-4">
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[1fr_200px]">
        <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black/40">
          <div
            className="absolute inset-0 opacity-40"
            style={{
              background:
                "radial-gradient(circle at 30% 40%, hsl(210 60% 40%), transparent 55%), radial-gradient(circle at 70% 60%, hsl(160 40% 30%), transparent 50%)",
            }}
          />
          <div className="relative text-center">
            <div className="mx-auto grid size-20 place-items-center rounded-full bg-brand text-[22px] font-semibold text-white">
              PH
            </div>
            <p className="mt-3 text-[14px] font-medium text-white">Preview Host</p>
            <p className="text-[12px] text-white/50">Camera stub — not publishing</p>
          </div>
        </div>
        <div className="hidden min-h-0 flex-col gap-2 md:flex">
          {people.map((p) => (
            <div
              key={p.name}
              className="flex flex-1 items-end rounded-lg bg-black/35 p-2.5"
            >
              <div>
                <div
                  className="mb-2 grid size-9 place-items-center rounded-full text-[11px] font-semibold text-white"
                  style={{ background: `hsl(${p.hue} 45% 42%)` }}
                >
                  {p.name
                    .split(" ")
                    .map((w) => w[0])
                    .join("")
                    .slice(0, 2)}
                </div>
                <div className="text-[11px] font-medium text-white">{p.name}</div>
                <div className="text-[10px] text-white/45">{p.role}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
