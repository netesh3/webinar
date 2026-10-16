"use client";

import "@excalidraw/excalidraw/index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  reconcileElements,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { WbElement } from "@/lib/whiteboard";
import type { WbCanvasLink, WbCollaborator } from "./whiteboard-context";

/* The Excalidraw editor itself. Its own module so the ~1 MB library is a chunk
 * that loads only when a board actually opens (whiteboard-stage.tsx imports this
 * with next/dynamic, ssr off — Excalidraw needs `window`). Nobody in a session
 * without a board downloads any of it.
 *
 * Images are switched off: a board is synced as elements, and an image would mean
 * shipping binary files to the whole audience. Loading and saving .excalidraw
 * files are off too — this is the room's board, not somebody's document. Export
 * image stays, so a host can keep what was drawn.
 */

const COLOURS = ["#3b82f6", "#a855f7", "#16a34a", "#ea580c", "#db2777", "#0891b2"];

function colourFor(identity: string): string {
  let h = 0;
  for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

export default function WhiteboardCanvas({
  link,
  canDraw,
  collaborators,
}: {
  link: WbCanvasLink;
  canDraw: boolean;
  collaborators: ReadonlyMap<string, WbCollaborator>;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Read once, at mount: everything after arrives through onRemote.
  const [initial] = useState(() => ({
    elements: link.elements() as unknown as OrderedExcalidrawElement[],
    appState: { viewBackgroundColor: "#ffffff" },
    scrollToContent: true,
  }));

  // Remote elements, folded into whatever is on this editor right now —
  // Excalidraw's own reconcile keeps a shape somebody is mid-drag on.
  useEffect(() => {
    if (!api) return;
    return link.onRemote((remote: WbElement[]) => {
      const merged = reconcileElements(
        api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[],
        remote as unknown as RemoteExcalidrawElement[],
        api.getAppState() as AppState,
      );
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    });
  }, [api, link]);

  // Everyone else's cursor, coloured per person.
  const map = useMemo(() => {
    const out = new Map<SocketId, Collaborator>();
    for (const [identity, c] of collaborators) {
      const stroke = colourFor(identity);
      out.set(identity as SocketId, {
        id: identity,
        username: c.name,
        pointer: c.pointer,
        button: c.button,
        color: { background: stroke, stroke },
      });
    }
    return out;
  }, [collaborators]);
  useEffect(() => {
    api?.updateScene({ collaborators: map, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, map]);

  // onChange fires on every pointer move too; the hub only sends what changed.
  const onChange = useRef(link.localChange);
  useEffect(() => {
    onChange.current = link.localChange;
  }, [link]);

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initial}
      viewModeEnabled={!canDraw}
      isCollaborating
      theme="light"
      name="Whiteboard"
      autoFocus={canDraw}
      handleKeyboardGlobally={false}
      onChange={(elements) => onChange.current(elements as unknown as readonly WbElement[])}
      onPointerUpdate={({ pointer, button }) => link.localPointer({ ...pointer, button })}
      UIOptions={{
        tools: { image: false },
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: true,
          toggleTheme: null,
          changeViewBackgroundColor: canDraw,
          clearCanvas: canDraw,
        },
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        {canDraw && <MainMenu.DefaultItems.ClearCanvas />}
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
}
