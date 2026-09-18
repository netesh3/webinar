/** Human-readable media capture failures (pre-join + in-room toggles). */

export type MediaKind = "camera" | "microphone" | "devices" | "screen";

function originHint(): string {
  if (typeof window === "undefined") return "this site";
  return window.location.host;
}

/** LiveKit / getUserMedia often put the DOMException name in `name`, not only `message`. */
export function mediaErrorKind(err: unknown): "denied" | "missing" | "other" {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const blob = `${name} ${message}`;
  if (/NotAllowed|PermissionDenied|permission|denied/i.test(blob)) return "denied";
  if (/NotFound|DevicesNotFound|Overconstrained|NotReadable/i.test(blob)) return "missing";
  return "other";
}

/** Detects when the user dismissed or canceled the browser's native screen share picker. */
export function isScreenShareCancel(err: unknown): boolean {
  if (!err) return false;
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    name === "NotAllowedError" ||
    name === "AbortError" ||
    /permission denied|not allowed|cancel|user denied/i.test(message)
  );
}

export function describeMediaError(err: unknown, kind: MediaKind): string {
  const host = originHint();
  const which =
    kind === "camera"
      ? "Camera"
      : kind === "microphone"
        ? "Microphone"
        : kind === "screen"
          ? "Screen sharing"
          : "Camera or microphone";
  switch (mediaErrorKind(err)) {
    case "denied":
      if (kind === "screen") {
        return `Screen sharing permission was denied. Check your browser and system screen recording permissions for ${host}.`;
      }
      return `${which} is blocked for ${host}. In your browser site settings, set Camera/Microphone to Allow for this exact address (apex and www are different), then reload. System Privacy can be on while this site is still Blocked.`;
    case "missing":
      return kind === "microphone"
        ? "No microphone was found (or it is in use by another app). You can still join."
        : kind === "camera"
          ? "No camera was found (or it is in use by another app). You can still join with mic only."
          : kind === "screen"
            ? "No screen or window was selected."
            : "No camera or microphone was found. You can still join and present with your screen.";
    default: {
      const message = err instanceof Error ? err.message : String(err ?? "");
      return `Couldn't open ${kind === "devices" ? "your devices" : kind === "screen" ? "screen sharing" : `your ${kind}`}. ${message}`;
    }
  }
}
