"use client";

import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import {
  CHAT_PERMISSION_OPEN_KEY,
  CHAT_PERMISSIONS,
  chatPermissionCopy,
  chatPermissionOf,
  chatPermissionOpenStored,
  chatPermissionPatch,
  chatPermissionStartsOpen,
  chatPermissionStep,
  type ChatPermission,
} from "@/lib/chat-permission";
import { Spinner } from "../controls";
import { ChatIcon, ChatOffIcon, ChevronDownIcon, LockIcon, UsersIcon } from "../icons";
import { Pill } from "./chat-badges";
import { useRoomUI } from "./context";

/* The host's "who may attendees chat with" control, at the top of the Chat panel.
 *
 * Open by default, so Everyone, Panelists, and Off are visible as soon as the host
 * opens Chat. The chevron still collapses it, and that lasts for this webinar even
 * if Chat is closed and opened again. A choice already saved in this browser is
 * kept, including a collapse. With nothing saved, collapsing is not stored, so the
 * next webinar starts open again. The row turns amber when chat is off, so a
 * collapsed control still shows the one state a host must not forget about.
 */

const ICONS: Record<ChatPermission, (p: { className?: string }) => React.ReactNode> = {
  everyone: UsersIcon,
  panelists: LockIcon,
  off: ChatOffIcon,
};

/* Open or closed for the webinar currently on screen. Not written to storage when
 * the browser has no saved preference, so a collapse here does not become the
 * default next time. A saved "0" or "1" is still updated. */
let session: { slug: string; open: boolean } | null = null;
const openListeners = new Set<() => void>();

function subscribeOpen(onChange: () => void): () => void {
  openListeners.add(onChange);
  return () => openListeners.delete(onChange);
}

function storedOpenValue(): string | null {
  try {
    return localStorage.getItem(CHAT_PERMISSION_OPEN_KEY);
  } catch {
    return null;
  }
}

function openFor(slug: string): boolean {
  if (session?.slug === slug) return session.open;
  return chatPermissionStartsOpen(storedOpenValue());
}

function openOnServer(): boolean {
  return true;
}

function rememberOpen(slug: string, open: boolean): void {
  const next = chatPermissionOpenStored(open, storedOpenValue());
  if (next !== null) {
    try {
      localStorage.setItem(CHAT_PERMISSION_OPEN_KEY, next);
    } catch {
      // Private mode: the in-memory copy still holds for this webinar.
    }
  }
  session = { slug, open };
  for (const listener of openListeners) listener();
}

function useAttendeeChatOpen(slug: string | null): boolean {
  const read = useCallback(() => (slug === null ? true : openFor(slug)), [slug]);
  return useSyncExternalStore(subscribeOpen, read, openOnServer);
}

/** Wired to the room: reads the live controls and writes the choice to the API. */
export function HostChatPermission() {
  const { slug, controls } = useRoomUI();
  const actual = chatPermissionOf(controls);
  const { value, pending, error, choose } = useChatPermissionWrite(actual, (p) =>
    api.updateControls(slug, chatPermissionPatch(p)),
  );
  return (
    <ChatPermissionControl
      slug={slug}
      value={value}
      pending={pending}
      error={error}
      onChoose={choose}
    />
  );
}

/* The write, with the thumb moving at once rather than after a round trip.
 *
 * Nothing local becomes the truth: the API mirrors the change into room metadata and
 * this tab hears it like every other browser. Until that arrives the pending choice
 * is shown; if the write fails the thumb goes back to what the room actually is, and
 * says why. A write that succeeds but whose broadcast never lands is released after
 * a few seconds rather than leaving the control stuck. */
export function useChatPermissionWrite(
  actual: ChatPermission,
  write: (p: ChatPermission) => Promise<unknown>,
) {
  const [pending, setPending] = useState<{ to: ChatPermission } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Landed: the room now says what was asked for. Adjusted during render, which
  // React supports for a component's own state, rather than in an effect.
  if (pending && actual === pending.to) setPending(null);

  async function choose(to: ChatPermission) {
    if (pending || to === actual) return;
    const token = { to };
    setPending(token);
    setError(null);
    try {
      await write(to);
      setTimeout(() => setPending((cur) => (cur === token ? null : cur)), 5000);
    } catch (err) {
      setPending((cur) => (cur === token ? null : cur));
      setError(
        `Couldn't change attendee chat. ${
          err instanceof Error && err.message ? err.message : "Please try again."
        }`,
      );
    }
  }

  return { value: pending?.to ?? actual, pending: pending?.to ?? null, error, choose };
}

/* ------------------------------------------------------------ attendee side */

/** What an attendee sees in place of the composer while the host has chat off. */
export function AttendeeChatOffNotice() {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2.5"
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full bg-warn/15 text-warn"
      >
        <ChatOffIcon className="size-3.5" />
      </span>
      <div className="min-w-0 text-[12px] leading-snug">
        <p className="font-semibold text-ink">Chat is off</p>
        <p className="mt-0.5 text-ink-2">
          The host has turned off chat for attendees. You can still read messages here.
        </p>
      </div>
    </div>
  );
}

/** Who an attendee's message will reach — the host's setting, told rather than asked. */
export function AttendeeAudience({ destination }: { destination: "everyone" | "panelists" }) {
  const stageOnly = destination === "panelists";
  return (
    <div className="mb-2 text-[11.5px]">
      <p className="flex min-w-0 items-center gap-1.5">
        <span className="text-ink-3">To</span>
        <span
          className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${
            stageOnly
              ? "border-warn/25 bg-warn-soft text-warn"
              : "border-line-2 bg-surface-2 text-ink-2"
          }`}
        >
          {stageOnly ? (
            <LockIcon className="size-3 shrink-0" />
          ) : (
            <UsersIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">{stageOnly ? "Host and panelists" : "Everyone"}</span>
        </span>
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        {stageOnly
          ? "Only the host and panelists will see this. Other attendees will not."
          : "Everyone in the webinar will see this."}
      </p>
    </div>
  );
}

/** The control itself, with no room behind it — so it can be looked at on its own. */
export function ChatPermissionControl({
  slug,
  value,
  pending,
  error,
  onChoose,
  defaultOpen,
}: {
  /** This webinar. The chevron is remembered for it until the next one. */
  slug?: string;
  /** What to show as selected: the pending choice while one is saving. */
  value: ChatPermission;
  pending: ChatPermission | null;
  error: string | null;
  onChoose: (p: ChatPermission) => void;
  /** Pins the row open or closed for a control with no room behind it. */
  defaultOpen?: boolean;
}) {
  const roomOpen = useAttendeeChatOpen(slug ?? null);
  const live = slug !== undefined && defaultOpen === undefined;
  const [fallbackOpen, setFallbackOpen] = useState(defaultOpen ?? true);
  // A failed write is shown where it was made, even if the host collapsed the row
  // while it was saving. Adjusted during render rather than in an effect.
  const [seenError, setSeenError] = useState(error);
  const [errorOpen, setErrorOpen] = useState(false);
  if (error !== seenError) {
    setSeenError(error);
    if (error) setErrorOpen(true);
  }
  const setOpen = (v: boolean) => {
    if (!v) setErrorOpen(false);
    if (live && slug !== undefined) rememberOpen(slug, v);
    else setFallbackOpen(v);
  };
  const expanded = errorOpen || (live ? roomOpen : fallbackOpen);

  const bodyId = useId();
  const labelId = useId();
  const off = value === "off";
  const copy = chatPermissionCopy(value);
  const EffectIcon = ICONS[value];

  const segments = useRef<Record<string, HTMLButtonElement | null>>({});
  const index = CHAT_PERMISSIONS.indexOf(value);

  return (
    <section
      aria-label="Attendee chat"
      className={`shrink-0 border-b motion-safe:transition-colors ${
        off ? "border-warn/25 bg-warn/[0.06]" : "border-line"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-inset md:min-h-10"
      >
        <span
          aria-hidden
          className={`grid size-6 shrink-0 place-items-center rounded-md ${
            off ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-2"
          }`}
        >
          {off ? <ChatOffIcon className="size-3.5" /> : <ChatIcon className="size-3.5" />}
        </span>
        <span id={labelId} className="shrink-0 text-[12.5px] font-medium text-ink">
          Attendee chat
        </span>
        {!expanded && (
          <Pill
            tone={off ? "warn" : value === "everyone" ? "stage" : "neutral"}
            className="inline-flex min-w-0 items-center gap-[3px] truncate"
          >
            {value === "panelists" && <LockIcon className="size-2.5" aria-hidden />}
            {pending && <Spinner className="size-2.5" />}
            {copy.summary}
          </Pill>
        )}
        <span className="flex-1" />
        <ChevronDownIcon
          className={`size-4 shrink-0 text-ink-3 motion-safe:transition-transform motion-safe:duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      <div id={bodyId} hidden={!expanded} className="px-3 pb-3">
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={`${bodyId}-effect`}
          aria-busy={pending !== null}
          className="relative grid grid-cols-3 rounded-[10px] border border-line bg-surface-2 p-[3px]"
        >
          {/* The sliding thumb. One element moved by transform, not three
              backgrounds swapped, so the choice visibly travels to where it lands. */}
          <span
            aria-hidden
            className={`pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-[7px] border shadow-sm motion-safe:transition-[translate,background-color,border-color] motion-safe:duration-200 motion-safe:ease-out ${
              off ? "border-warn/30 bg-warn-soft" : "border-line-2 bg-surface"
            }`}
            style={{ translate: `${index * 100}% 0` }}
          />
          {CHAT_PERMISSIONS.map((p) => {
            const Icon = ICONS[p];
            const checked = p === value;
            const saving = pending === p;
            const { label } = chatPermissionCopy(p);
            return (
              <button
                key={p}
                ref={(el) => {
                  segments.current[p] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                // Not `disabled`: that would drop keyboard focus out of the group
                // mid-save. Clicks are ignored while one is in flight instead.
                aria-disabled={pending !== null && !saving}
                tabIndex={checked ? 0 : -1}
                onClick={() => onChoose(p)}
                onKeyDown={(e) => {
                  // Arrows move focus; Space or Enter chooses. Selection does not
                  // follow focus here, because every choice is broadcast to the
                  // whole audience: arrowing from Everyone to Off must not flip
                  // chat through Panelists on the way.
                  const next = chatPermissionStep(p, e.key);
                  if (!next) return;
                  e.preventDefault();
                  segments.current[next]?.focus();
                }}
                className={`relative z-10 inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-1.5 text-[12.5px] font-medium outline-none motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-brand/60 md:min-h-8 ${
                  checked
                    ? p === "off"
                      ? "text-warn"
                      : "text-ink"
                    : "text-ink-2 hover:text-ink aria-disabled:opacity-50 aria-disabled:hover:text-ink-2"
                }`}
              >
                {saving ? (
                  <Spinner className="size-3.5 shrink-0" />
                ) : (
                  <Icon
                    className={`size-3.5 shrink-0 ${
                      checked && p !== "off" ? "text-brand" : ""
                    }`}
                  />
                )}
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>

        <p
          id={`${bodyId}-effect`}
          aria-live="polite"
          className={`mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug ${
            off ? "text-warn" : "text-ink-2"
          }`}
        >
          <EffectIcon className="mt-px size-3.5 shrink-0 opacity-80" />
          <span>
            {copy.effect}
            {pending && <span className="text-ink-3"> Saving…</span>}
          </span>
        </p>

        {error && (
          <p role="alert" className="mt-1.5 text-[11.5px] leading-snug text-live">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
