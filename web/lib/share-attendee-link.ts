"use client";

/**
 * Share the public attendee registration / join landing URL
 * (`/webinars/<id>`). Uses the Web Share API when available; otherwise copies
 * to the clipboard. Same target as InviteMenu / Share tab.
 */
export async function shareAttendeeLink(opts: {
  url: string;
  topic: string;
  notify: (message: string, tone?: "info" | "ok" | "error") => void;
}): Promise<void> {
  const { url, topic, notify } = opts;
  const message = `${topic}\n\nJoin here: ${url}`;

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: topic, text: message, url });
      return;
    } catch {
      // User cancelled or share failed — fall through to clipboard.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    notify("Registration link copied.", "ok");
  } catch {
    notify(
      "Couldn't reach the clipboard. Open Manage → Share to copy the link.",
      "info",
    );
  }
}
