"use client";

import { useState, useSyncExternalStore } from "react";
import { CopyField } from "../controls";
import { CheckIcon, CopyIcon, SendIcon } from "../icons";
import { useShareOrigin, useToast } from "../providers";
import { useRoomUI } from "./context";

/* Invite, from inside the room.
 *
 * The link this shares is the LANDING page, not the room. That is the whole safety argument:
 * whoever opens it lands on the front door and still has to get through whatever the host set
 * up — register, or type a passcode, or wait to be approved. Sharing the room URL directly
 * would look more helpful and would hand out nothing usable, because the room exchanges a join
 * key or a session for a token and a stranger has neither.
 *
 * Available to the audience as well as the host, deliberately. The slug has always been the
 * shareable part of this product — it is what a forwarded invitation contains — so an attendee
 * passing it to a colleague can only offer the same front door they came through themselves.
 *
 * Two ways to copy, because they are two different tasks. The bare link is what goes into a
 * chat box that will render its own preview; the written invitation is what goes into an email
 * or a WhatsApp message, where a naked URL with no context gets ignored.
 */

const subscribeNothing = () => () => {};
const readCanShare = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";
const readCanShareOnServer = () => false;

export function InvitePanel() {
  const { slug, topic } = useRoomUI();
  const origin = useShareOrigin();
  const { notify } = useToast();
  const [copied, setCopied] = useState(false);

  const url = `${origin}/webinars/${slug}`;
  const message = `${topic}\n\nJoin here: ${url}`;

  /* The native share sheet, when the browser has one.
   *
   * Read through useSyncExternalStore rather than during render: `navigator.share` cannot be
   * answered on the server, and checking it in a render is a hydration mismatch on a panel
   * that otherwise looks fine. Same pattern as the screen-share button in the control bar.
   *
   * It exists mostly for phones, where it is the difference between "copy this and go find
   * the app yourself" and one tap into WhatsApp.
   */
  const canShare = useSyncExternalStore(
    subscribeNothing,
    readCanShare,
    readCanShareOnServer,
  );

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Refused permission, or an insecure origin. The link above is selectable, so this is
      // a nudge rather than an error state.
      notify(
        "Couldn't reach the clipboard. You can select the link above instead.",
        "info",
      );
      return;
    }
    setCopied(true);
    notify("Invitation copied.", "ok");
    setTimeout(() => setCopied(false), 1800);
  }

  async function share() {
    try {
      await navigator.share({ title: topic, text: message, url });
    } catch {
      // A cancelled share sheet throws exactly like a failed one, and telling somebody their
      // deliberate dismissal went wrong is worse than saying nothing.
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3.5">
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        Anyone with this link can join{" "}
        <span className="font-medium text-ink">{topic}</span>. They land on the
        webinar page first, so whatever you set up there still applies.
      </p>

      <CopyField label="Link to share" value={url} />

      <div className="grid gap-2">
        <button
          type="button"
          onClick={() => void copyMessage()}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-line-2 bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {copied ? (
            <>
              <CheckIcon className="size-4 text-ok" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon className="size-4" />
              Copy invitation
            </>
          )}
        </button>

        {canShare && (
          <button
            type="button"
            onClick={() => void share()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand px-3 text-[13px] font-semibold text-white transition-colors hover:bg-brand/90 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <SendIcon className="size-4" />
            Share…
          </button>
        )}
      </div>

      {/* The written form, shown rather than described. Somebody about to paste this into an
          email wants to know what they are pasting. */}
      <div className="mt-auto rounded-lg border border-line bg-surface-2 p-2.5">
        <p className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          What gets copied
        </p>
        <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed break-words whitespace-pre-line text-ink-2">
          {message}
        </p>
      </div>
    </div>
  );
}
