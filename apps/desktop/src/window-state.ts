/**
 * Remembers the main window's size, position and maximised state in
 * <userData>/window-state.json.
 */

import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const DEFAULT_BOUNDS = { width: 1280, height: 820 };

function statePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

/** True when at least a usable corner of the rectangle is on some display. */
function isVisible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const left = Math.max(a.x, bounds.x);
    const top = Math.max(a.y, bounds.y);
    const right = Math.min(a.x + a.width, bounds.x + bounds.width);
    const bottom = Math.min(a.y + a.height, bounds.y + bounds.height);
    return right - left >= 100 && bottom - top >= 50;
  });
}

export function loadWindowState(): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as WindowState;
    const b = raw.bounds;
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 400 && b.height >= 300) {
      if (isVisible(b)) return { ...b, maximized: !!raw.maximized };
      return { width: b.width, height: b.height, maximized: !!raw.maximized };
    }
  } catch {
    // first run or unreadable: use the defaults
  }
  return { ...DEFAULT_BOUNDS, maximized: false };
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;

  const save = () => {
    if (win.isDestroyed()) return;
    const state: WindowState = {
      // getNormalBounds keeps the pre-maximise size, so un-maximising next
      // launch goes back to where the user had it.
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
    };
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(state));
    } catch (err) {
      console.warn("[window-state] save failed", err);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };

  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", () => {
    clearTimeout(timer);
    save();
  });
}
