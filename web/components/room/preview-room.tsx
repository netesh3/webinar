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
  // Share is a core host control — show it in chrome preview. ControlBar mocks
  // the action when previewChrome is set so we never call getDisplayMedia here.
  canShareScreen: true,
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
      previewChrome: true,
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
  const { topic } = useRoomUI();
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
    </header>
  );
}

type MockPerson = {
  id: string;
  name: string;
  role: string;
  hue: string;
  /** Mock screen-share tile for spotlight / speaker share layout. */
  share?: boolean;
};

const MOCK_PEOPLE: MockPerson[] = [
  { id: "share", name: "Product slides", role: "Screen share", hue: "35", share: true },
  { id: "host", name: "Preview Host", role: "Host", hue: "210" },
  { id: "p1", name: "Alex Chen", role: "Panelist", hue: "160" },
  { id: "p2", name: "Sam Ortiz", role: "Panelist", hue: "280" },
  { id: "p3", name: "Asha Mehta", role: "Panelist", hue: "12" },
  { id: "p4", name: "Jordan Lee", role: "Panelist", hue: "190" },
];

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

function MockTile({
  person,
  size = "md",
}: {
  person: MockPerson;
  size?: "lg" | "md" | "sm";
}) {
  const pad = size === "lg" ? "p-4" : size === "md" ? "p-2.5" : "p-2";
  const avatar =
    size === "lg" ? "size-20 text-[22px]" : size === "md" ? "size-11 text-[13px]" : "size-8 text-[11px]";
  return (
    <div
      className={`relative flex size-full min-h-0 items-end overflow-hidden rounded-xl bg-black/40 ${pad}`}
    >
      <div
        className="absolute inset-0 opacity-45"
        style={{
          background: person.share
            ? "linear-gradient(145deg, hsl(35 50% 28%), hsl(210 30% 18%) 55%, hsl(220 20% 12%))"
            : `radial-gradient(circle at 35% 40%, hsl(${person.hue} 55% 38%), transparent 55%), radial-gradient(circle at 70% 70%, hsl(${person.hue} 40% 22%), transparent 50%)`,
        }}
      />
      {person.share ? (
        <div className="relative w-full text-center">
          <div className="mx-auto mb-2 h-16 w-[72%] max-w-md rounded-md border border-white/15 bg-white/10 shadow-inner" />
          <p className="text-[13px] font-medium text-white">{person.name}</p>
          <p className="text-[11px] text-white/50">{person.role}</p>
        </div>
      ) : (
        <div className="relative">
          <div
            className={`mb-2 grid place-items-center rounded-full font-semibold text-white ${avatar}`}
            style={{ background: `hsl(${person.hue} 45% 42%)` }}
          >
            {initials(person.name)}
          </div>
          <div
            className={`font-medium text-white ${size === "sm" ? "text-[11px]" : "text-[13px]"}`}
          >
            {person.name}
          </div>
          <div className="text-[10px] text-white/45">{person.role}</div>
        </div>
      )}
    </div>
  );
}

/** Mock stage that follows the same layout modes as the live Stage. */
function PreviewStage() {
  const { stage } = useRoomUI();
  const mode = stage.mode;
  const share = MOCK_PEOPLE.find((p) => p.share)!;
  const cameras = MOCK_PEOPLE.filter((p) => !p.share);
  const focus = mode === "spotlight" ? share : cameras[0];
  const rest =
    mode === "spotlight"
      ? cameras
      : mode === "speaker"
        ? cameras.slice(1)
        : cameras;

  return (
    <div className="relative flex size-full min-h-0 flex-col">
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-lg bg-black/55 p-0.5 backdrop-blur">
        {(["speaker", "grid", "spotlight"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            title={`${option[0].toUpperCase()}${option.slice(1)} view`}
            onClick={() => stage.setMode(option)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
              mode === option ? "bg-white/25 text-white" : "text-white/70 hover:text-white"
            }`}
          >
            {option === "speaker" ? "Speaker" : option === "grid" ? "Grid" : "Spotlight"}
          </button>
        ))}
      </div>

      {mode === "grid" ? (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <div
            className="grid h-full min-h-0 content-center gap-2"
            style={{
              gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${
                cameras.length <= 4 ? "280px" : "200px"
              }), 1fr))`,
            }}
          >
            {cameras.map((p) => (
              <div key={p.id} className="aspect-video min-h-0">
                <MockTile person={p} size="md" />
              </div>
            ))}
          </div>
        </div>
      ) : mode === "spotlight" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
          <div className="min-h-0 flex-1">
            <MockTile person={focus} size="lg" />
          </div>
          <div
            className="flex shrink-0 gap-2 overflow-auto lg:flex-col [scrollbar-width:thin]"
            style={{ ["--spot" as string]: "clamp(180px, 20vw, 300px)" }}
          >
            {rest.slice(0, 2).map((p) => (
              <div
                key={p.id}
                className="aspect-video shrink-0 lg:w-[var(--spot)]"
                style={{ height: "clamp(96px, 18vh, 170px)" }}
              >
                <MockTile person={p} size="md" />
              </div>
            ))}
            {rest.length > 2 && (
              <span className="grid shrink-0 place-items-center rounded-lg bg-white/10 px-3 text-[12px] font-medium text-white/75 lg:w-[var(--spot)] lg:py-2">
                +{rest.length - 2} more
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">
            <MockTile person={focus} size="lg" />
          </div>
          {rest.length > 0 && (
            <div
              className="flex shrink-0 gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
              style={{ height: "clamp(72px, 15vh, 132px)" }}
            >
              {rest.map((p) => (
                <div key={p.id} className="aspect-video h-full shrink-0">
                  <MockTile person={p} size="sm" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
