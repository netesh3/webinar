"use client";

/* The installable app and Web Push, as UI.
 *
 *   PwaBoot          registers /sw.js after the page has loaded, and catches Chrome's
 *                    one-time install prompt. Asks for nothing.
 *   InstallAppItem   "Install app" in the account menu: Chrome's prompt where there is one,
 *                    Share → Add to Home Screen instructions on iPhone and iPad.
 *   PushOptIn        "Get a notification when it starts?" on the registration confirmation.
 *   NotificationsSection  Settings → Notifications: this device, the toggles, a test.
 *
 * Decisions are lib/push.ts (tested); browser calls are lib/push-client.ts.
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { MaterialIcon } from "./icons";
import { Alert, Modal, Spinner, Toggle } from "./controls";
import { useToast } from "./providers";
import { Button, Card } from "./ui";
import type { PushKind, PushPreference, PushPreferencesResponse } from "@/lib/api-types";
import { installKind, optInKey, optInState, type OptInState, type PushSupport } from "@/lib/push";
import {
  PushError,
  captureInstallPrompt,
  currentPermission,
  currentPushSupport,
  currentSubscription,
  disablePush,
  enablePush,
  installSnapshot,
  isStandalone,
  promptInstall,
  pushApi,
  registerServiceWorker,
  subscribeInstall,
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

// ------------------------------------------------------------------ install

const noop = () => () => {};

function useInstall() {
  // Re-render when the prompt arrives or is used; the snapshot is just a version string.
  useSyncExternalStore(subscribeInstall, installSnapshot, () => "00");
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  if (!mounted) return "none" as const;
  return installKind({
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: isStandalone(),
    deferredPrompt: installSnapshot().startsWith("1"),
  });
}

/** Share → Add to Home Screen, the only way in on iOS (and the only way iOS gets push). */
export function IosInstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Install Webinar Liv" size="sm">
      <ol className="list-decimal space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-2">
        <li>
          In Safari, tap <b>Share</b>{" "}
          <MaterialIcon name="ios_share" className="!text-[16px] align-[-3px]" /> at the bottom (or top on
          iPad).
        </li>
        <li>
          Choose <b>Add to Home Screen</b>.
        </li>
        <li>Open Webinar Liv from your Home Screen.</li>
      </ol>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
        On iPhone and iPad, notifications work only in the installed app (iOS 16.4 or later).
      </p>
    </Modal>
  );
}

/** "Install app" for the account menu. Renders nothing when there is nothing to offer. */
export function InstallAppItem({
  className,
  onDone,
  icon,
}: {
  className: string;
  onDone?: () => void;
  icon?: ReactNode;
}) {
  const kind = useInstall();
  const [ios, setIos] = useState(false);
  if (kind === "none") return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          if (kind === "prompt") {
            void promptInstall().finally(() => onDone?.());
          } else {
            setIos(true);
          }
        }}
      >
        {icon ?? <MaterialIcon name="install_mobile" className="!text-[16px] text-ink-2" />}
        Install app
      </button>
      <IosInstallModal
        open={ios}
        onClose={() => {
          setIos(false);
          onDone?.();
        }}
      />
    </>
  );
}

/** The same choice, for menus that take items (components/top-nav.tsx). */
export function useInstallMenuAction(): { action: (() => void) | null; modal: ReactNode } {
  const kind = useInstall();
  const [ios, setIos] = useState(false);
  return {
    action: kind === "none" ? null : () => (kind === "prompt" ? void promptInstall() : setIos(true)),
    modal: <IosInstallModal open={ios} onClose={() => setIos(false)} />,
  };
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

  const state: OptInState = optInState({ serverEnabled, support, permission, subscribed, busy });
  return { state, setBusy, refresh };
}

// ------------------------------------------------------------------ registration opt-in

/** After registering: "Get a notification when it starts?" Never shown unasked-for. */
export function PushOptIn({ joinKey, meeting = false }: { joinKey: string; meeting?: boolean }) {
  const { state, setBusy, refresh } = usePushState(joinKey);
  const { notify } = useToast();
  const [ios, setIos] = useState(false);
  const what = meeting ? "meeting" : "webinar";

  if (state === "hidden") return null;

  async function turnOn() {
    setBusy(true);
    try {
      const sub = await enablePush(joinKey);
      window.localStorage.setItem(optInKey(joinKey), sub.endpoint);
      notify(`You'll get a notification when the ${what} starts.`, "ok");
    } catch (err) {
      const msg = err instanceof PushError || err instanceof Error ? err.message : "Could not turn on notifications.";
      notify(msg, "error");
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

  return (
    <div className="mt-4 flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3">
      <MaterialIcon name="notifications_active" className="mt-0.5 !text-[20px] text-brand" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
        {state === "on" ? (
          <>
            <strong className="block text-ink">Notifications on</strong>
            You&apos;ll be told 15 minutes before and when it starts.{" "}
            <button type="button" onClick={() => void turnOff()} className="font-medium text-brand hover:underline">
              Turn off
            </button>
          </>
        ) : state === "blocked" ? (
          <>
            <strong className="block text-ink">Notifications are blocked</strong>
            Allow notifications for this site in your browser&apos;s settings, then try again.
          </>
        ) : state === "install" ? (
          <>
            <strong className="block text-ink">Get a notification when it starts?</strong>
            On iPhone and iPad, add Webinar Liv to your Home Screen first.{" "}
            <button type="button" onClick={() => setIos(true)} className="font-medium text-brand hover:underline">
              How
            </button>
            <IosInstallModal open={ios} onClose={() => setIos(false)} />
          </>
        ) : (
          <>
            <strong className="block text-ink">Get a notification when it starts?</strong>
            We&apos;ll remind you 15 minutes before, and tell you the moment the {what} goes live.
          </>
        )}
      </div>
      {(state === "ask" || state === "busy") && (
        <Button type="button" size="sm" disabled={state === "busy"} onClick={() => void turnOn()}>
          {state === "busy" ? <Spinner className="size-3.5" /> : "Notify me"}
        </Button>
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
  const [ios, setIos] = useState(false);
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
                On iPhone and iPad, notifications work in the installed app.{" "}
                <button type="button" onClick={() => setIos(true)} className="font-medium text-brand hover:underline">
                  Add to Home Screen
                </button>
                <IosInstallModal open={ios} onClose={() => setIos(false)} />
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
