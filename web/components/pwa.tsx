"use client";

/* Web Push, as UI. The site still registers /sw.js for notifications; it does not offer
 * a PWA. Native Mac/iOS/Android/desktop downloads live at /download ("Get the app").
 *
 *   PwaBoot          registers /sw.js after the page has loaded, and swallows Chrome's
 *                    install prompt so the browser does not offer a PWA on its own.
 *   PushOptIn        "Get notified when it starts" on the registration confirmation and a
 *                    meeting's waiting screen.
 *   NotificationsSection  Settings → Notifications: this device, the toggles, a test.
 *
 * Decisions are lib/push.ts (tested); browser calls are lib/push-client.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { MaterialIcon } from "./icons";
import { Alert, Spinner, Toggle } from "./controls";
import { useSession, useToast } from "./providers";
import { Button, Card } from "./ui";
import { GetAppLink } from "./get-app-link";
import type { PushKind, PushPreference, PushPreferencesResponse } from "@/lib/api-types";
import { isNativeAppUA } from "@/lib/device";
import {
  dismissKey,
  notifyCardState,
  optInKey,
  optInState,
  pushHost,
  unblockHint,
  type OptInState,
  type PushHost,
  type PushSupport,
} from "@/lib/push";
import {
  PushError,
  captureInstallPrompt,
  currentPermission,
  currentPushSupport,
  currentSubscription,
  disablePush,
  enablePush,
  pushApi,
  registerServiceWorker,
} from "@/lib/push-client";

// ------------------------------------------------------------------ boot

/** Rooms are left alone until the session is over: nothing competes with joining media. */
function isRoomPath(pathname: string): boolean {
  return /^\/(webinars|host)\/[^/]+\/room(\/|$)/.test(pathname);
}

export function PwaBoot() {
  useEffect(() => {
    captureInstallPrompt();
    if (isRoomPath(window.location.pathname)) return;
    const run = () => void registerServiceWorker();
    if (document.readyState === "complete") {
      const id = window.setTimeout(run, 1500);
      return () => window.clearTimeout(id);
    }
    window.addEventListener("load", run, { once: true });
    return () => window.removeEventListener("load", run);
  }, []);
  return null;
}

// ------------------------------------------------------------------ push state

function usePushState(joinKey?: string) {
  const [serverEnabled, setServerEnabled] = useState(false);
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  // What the browser says now. A registration opt-in is remembered per join key: the
  // browser's one subscription may exist for the account or another webinar.
  const read = useCallback(async () => {
    const sub = await currentSubscription();
    const mine = joinKey ? window.localStorage.getItem(optInKey(joinKey)) === sub?.endpoint : true;
    return { support: currentPushSupport(), permission: currentPermission(), subscribed: Boolean(sub) && mine };
  }, [joinKey]);

  const apply = useCallback((s: { support: PushSupport; permission: NotificationPermission; subscribed: boolean }) => {
    setSupport(s.support);
    setPermission(s.permission);
    setSubscribed(s.subscribed);
  }, []);

  const refresh = useCallback(() => read().then(apply), [read, apply]);

  useEffect(() => {
    let cancelled = false;
    pushApi
      .publicKey()
      .then((k) => {
        if (!cancelled) setServerEnabled(k.enabled);
      })
      .catch(() => {});
    read()
      .then((s) => {
        if (!cancelled) apply(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [read, apply]);

  /* Back from the browser's site settings (unblocking, say): read the permission again, so
   * "blocked" turns back into the button without a reload. (31 Oct 2026) */
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [refresh]);

  const raw = { serverEnabled, support, permission, subscribed, busy };
  const state: OptInState = optInState(raw);
  return { state, raw, setBusy, refresh };
}

// ------------------------------------------------------------------ registration opt-in

/* Where the page runs and what the browser keeps, read after hydration: the server render
 * knows neither, so both renders start hidden and agree. */
function useCardContext(slug: string) {
  const [ctx, setCtx] = useState<{ host: PushHost; dismissed: boolean; ua: string; touch: number } | null>(null);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(dismissKey(slug)) !== null;
    } catch {
      // Storage blocked: the card shows, and "Not now" only lasts the page.
    }
    const ua = navigator.userAgent || "";
    queueMicrotask(() =>
      setCtx({
        host: pushHost({ nativeAppUA: isNativeAppUA(ua), desktopBridge: "webinarlivDesktop" in window }),
        dismissed,
        ua,
        touch: navigator.maxTouchPoints || 0,
      }),
    );
  }, [slug]);
  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(dismissKey(slug), String(Date.now()));
    } catch {
      // Storage blocked: dismissed for this page only.
    }
    setCtx((c) => (c ? { ...c, dismissed: true } : c));
  }, [slug]);
  return { ctx, dismiss };
}

/** "Get notified when it starts", after registering for a webinar and while waiting in a
 *  meeting's lobby (31 Oct 2026). One tap asks for permission and subscribes this browser
 *  to the registration's join key, so a guest with no account gets the 15-minute reminder
 *  and the "starting now" push too (api/internal/store/push.go QueuePushToRegistrants).
 *  Never asks on its own, and "Not now" is remembered per session in this browser. Inside
 *  our apps there is no browser prompt: the phone app's own push covers a signed-in
 *  account, and the desktop app has no push at all. */
export function PushOptIn({
  slug,
  joinKey,
  meeting = false,
  fallback,
}: {
  slug: string;
  joinKey: string;
  meeting?: boolean;
  /** Where the reminder comes from when this browser cannot be notified ("Your confirmation
   *  email has the join link."). Optional: a meeting guest gets no email. */
  fallback?: string;
}) {
  const { raw, setBusy, refresh } = usePushState(joinKey);
  const { ctx, dismiss } = useCardContext(slug);
  const { account, status } = useSession();
  const { notify } = useToast();
  const what = meeting ? "meeting" : "webinar";

  const state = ctx
    ? notifyCardState({ ...raw, host: ctx.host, dismissed: ctx.dismissed, signedIn: status === "signed-in" && account !== null })
    : "hidden";
  if (state === "hidden") return null;

  async function turnOn() {
    setBusy(true);
    try {
      const sub = await enablePush(joinKey);
      window.localStorage.setItem(optInKey(joinKey), sub.endpoint);
      notify(`You'll get a notification when the ${what} starts.`, "ok");
    } catch (err) {
      // A refusal shows as the card's "blocked" state; anything else is worth a toast.
      if (!(err instanceof PushError && err.code === "denied")) {
        notify(err instanceof Error ? err.message : "Could not turn on notifications.", "error");
      }
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await disablePush(joinKey);
      window.localStorage.removeItem(optInKey(joinKey));
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const icon =
    state === "on" || state === "app"
      ? "notifications_active"
      : state === "blocked" || state === "unsupported"
        ? "notifications_off"
        : "notifications";

  return (
    <div
      className="mt-4 flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-left"
      role="status"
      aria-live="polite"
    >
      <MaterialIcon name={icon} className="mt-0.5 !text-[20px] text-brand" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
        {state === "on" ? (
          <>
            <strong className="block text-ink">
              <MaterialIcon name="check" className="mr-0.5 align-[-3px] !text-[16px] text-brand" />
              Notifications on
            </strong>
            You&apos;ll be told 15 minutes before and the moment the {what} starts.{" "}
            <button type="button" onClick={() => void turnOff()} className="font-medium text-brand hover:underline">
              Turn off
            </button>
          </>
        ) : state === "app" ? (
          <>
            <strong className="block text-ink">You&apos;ll get a notification in the app</strong>
            15 minutes before, and when the {what} starts. Change it in Settings → Notifications.
          </>
        ) : state === "blocked" ? (
          <>
            <strong className="block text-ink">Notifications are blocked for this site</strong>
            {ctx ? unblockHint(ctx.ua, ctx.touch) : null}
            {fallback ? ` ${fallback}` : ""}
          </>
        ) : state === "install" ? (
          <>
            <strong className="block text-ink">Get the app for notifications</strong>
            Safari on iPhone and iPad can&apos;t notify you from a website tab. The Webinar Liv app
            can.{fallback ? ` ${fallback}` : ""}{" "}
            <GetAppLink className="font-medium text-brand hover:underline">Get the app</GetAppLink>
          </>
        ) : state === "unsupported" ? (
          <>
            <strong className="block text-ink">This browser can&apos;t notify you</strong>
            {fallback ?? `Keep this link to get back to the ${what}.`}{" "}
            <GetAppLink className="font-medium text-brand hover:underline">Get the app for notifications</GetAppLink>
          </>
        ) : (
          <>
            <strong className="block text-ink">Get notified when it starts</strong>
            A reminder 15 minutes before, and a notification the moment the {what} goes live.
          </>
        )}
        {(state === "ask" || state === "busy") && (
          <div className="mt-2">
            <Button type="button" size="sm" disabled={state === "busy"} onClick={() => void turnOn()}>
              {state === "busy" ? <Spinner className="size-3.5" /> : <MaterialIcon name="notifications" className="!text-[16px]" />}
              Enable notifications
            </Button>
          </div>
        )}
      </div>
      {state !== "on" && state !== "busy" && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          title="Not now"
          className="-mr-1 -mt-0.5 rounded p-0.5 text-ink-3 hover:bg-surface hover:text-ink"
        >
          <MaterialIcon name="close" className="!text-[18px]" />
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings

const LABELS: Record<string, { label: string; description: string }> = {
  webinar_live: { label: "Webinar starting now", description: "When a webinar you registered for goes live." },
  webinar_reminder: { label: "15 minutes before", description: "A reminder before a webinar you registered for." },
  replay_ready: { label: "Recording available", description: "When the replay of a webinar you registered for is up." },
  meeting_started: { label: "Meeting started", description: "When a meeting you were invited to starts." },
  lobby_knock: { label: "Someone in the lobby", description: "Somebody is waiting to join your meeting and you're not in it." },
  approval_requested: { label: "Registrations to approve", description: "A new registration for a webinar that needs approval." },
  recap_ready: { label: "Recap ready", description: "Your session's AI recap is ready." },
  recording_expiring: { label: "Recordings expiring", description: "Recordings about to be deleted, 7 days and 1 day ahead." },
  ops_alert: { label: "Operator alerts (admins)", description: "The video server could not be started, or was not ready when a session began." },
};

/** Settings → Notifications. */
export function NotificationsSection({ canHost }: { canHost: boolean }) {
  const { state, setBusy, refresh } = usePushState();
  const { notify } = useToast();
  const [prefs, setPrefs] = useState<PushPreferencesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    pushApi
      .preferences()
      .then((p) => {
        setPrefs(p);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load notifications."));
  }, []);
  useEffect(load, [load]);

  async function setDevice(on: boolean) {
    setBusy(true);
    try {
      if (on) await enablePush();
      else await disablePush();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change notifications.", "error");
    } finally {
      setBusy(false);
      void refresh();
      load();
    }
  }

  async function toggle(kind: PushKind, enabled: boolean) {
    setPrefs((p) =>
      p ? { ...p, preferences: p.preferences.map((x) => (x.kind === kind ? { ...x, enabled } : x)) } : p,
    );
    try {
      setPrefs(await pushApi.setPreferences([{ kind, enabled, host: false }]));
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save.", "error");
      load();
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await pushApi.test();
      notify(`Test sent to ${res.queued} device${res.queued === 1 ? "" : "s"}.`, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not send a test.", "error");
    } finally {
      setTesting(false);
    }
  }

  const shown: PushPreference[] = (prefs?.preferences ?? []).filter((p) => canHost || !p.host);
  const attendee = shown.filter((p) => !p.host);
  const host = shown.filter((p) => p.host);

  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Notifications</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Notifications on this device, even when the site isn&apos;t open. Emails are not affected.
      </p>

      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {prefs && !prefs.enabled ? (
        <Card className="mt-4 p-5 text-[13px] text-ink-2">Notifications aren&apos;t set up on this server yet.</Card>
      ) : (
        <>
          <Card className="mt-4 p-5">
            <h3 className="text-[13.5px] font-semibold">This device</h3>
            {state === "hidden" ? (
              <p className="mt-1 text-[12.5px] text-ink-2">This browser can&apos;t get notifications.</p>
            ) : state === "install" ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                On iPhone and iPad, notifications work in the app.{" "}
                <GetAppLink className="font-medium text-brand hover:underline">Get the app</GetAppLink>
              </p>
            ) : state === "blocked" ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                Notifications are blocked for this site. Allow them in your browser&apos;s site settings.
              </p>
            ) : (
              <div className="mt-1">
                <Toggle
                  checked={state === "on"}
                  disabled={state === "busy"}
                  onChange={(on) => void setDevice(on)}
                  label="Notifications on this device"
                  description={
                    prefs && prefs.devices > 0
                      ? `On for ${prefs.devices} device${prefs.devices === 1 ? "" : "s"} on this account.`
                      : "Your browser will ask for permission."
                  }
                />
              </div>
            )}
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={testing || !prefs || prefs.devices === 0}
                onClick={() => void sendTest()}
              >
                {testing ? <Spinner className="size-3.5" /> : <MaterialIcon name="send" className="!text-[16px]" />}
                Send test notification
              </Button>
            </div>
          </Card>

          {prefs && (
            <Card className="mt-4 p-5">
              <h3 className="text-[13.5px] font-semibold">As an attendee</h3>
              <div className="mt-1">
                {attendee.map((p) => (
                  <Toggle
                    key={p.kind}
                    checked={p.enabled}
                    onChange={(on) => void toggle(p.kind, on)}
                    label={LABELS[p.kind]?.label ?? p.kind}
                    description={LABELS[p.kind]?.description}
                  />
                ))}
              </div>
              {host.length > 0 && (
                <>
                  <h3 className="mt-4 text-[13.5px] font-semibold">As a host</h3>
                  <div className="mt-1">
                    {host.map((p) => (
                      <Toggle
                        key={p.kind}
                        checked={p.enabled}
                        onChange={(on) => void toggle(p.kind, on)}
                        label={LABELS[p.kind]?.label ?? p.kind}
                        description={LABELS[p.kind]?.description}
                      />
                    ))}
                  </div>
                </>
              )}
            </Card>
          )}
        </>
      )}
    </section>
  );
}
