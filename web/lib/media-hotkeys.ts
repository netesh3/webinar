/** Whether a key event is for typing rather than a room shortcut.
 *
 *  M, V and Space are also characters. Without this, muting while composing a
 *  chat message is the first thing a host would hit, and it is not recoverable
 *  in the sentence they were in the middle of. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target == null) return false;
  // Duck-typed so the same function is testable under Node, where HTMLElement
  // is not defined, and still correct in the browser.
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/** Keys the room treats as media shortcuts, once typing is ruled out. */
export type MediaHotkey = "mute" | "camera" | "ptt-down" | "ptt-up";

export function mediaHotkey(
  e: Pick<KeyboardEvent, "code" | "repeat" | "metaKey" | "ctrlKey" | "altKey">,
  phase: "down" | "up",
): MediaHotkey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (phase === "up") {
    return e.code === "Space" ? "ptt-up" : null;
  }
  if (e.code === "Space") return "ptt-down";
  if (e.repeat) return null;
  if (e.code === "KeyM") return "mute";
  if (e.code === "KeyV") return "camera";
  return null;
}
