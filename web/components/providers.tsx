"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ApiError, api } from "@/lib/api";
import { dropCache, writeCache } from "@/lib/http";
import type { Account, AppConfig, ProfilePatch, SignupResponse } from "@/lib/api-types";
import { DEV_BYPASS_ACCOUNT, isDevAuthBypass } from "@/lib/dev-bypass";
import {
  isDevAuthBypassActive,
  setDevBypassOptedOut,
} from "@/lib/dev-bypass-session";
import { ThemeProvider } from "./theme";

/* App-wide client state: who is signed in, what the operator named this
 * instance, and transient toasts.
 *
 * The session cannot be resolved on the server: it is an httpOnly cookie scoped
 * to the API's origin, and a Server Component render on :3000 does not carry it
 * to :8080. So `status` starts at "loading" and the UI renders a skeleton rather
 * than briefly claiming nobody is signed in.
 */

// ------------------------------------------------------------------- config

/** Used only until the real config arrives — and as the fallback when the API is
 *  unreachable, so the shell still renders instead of blanking. */
const CONFIG_FALLBACK: AppConfig = {
  appName: "Webinar Liv",
  webBaseUrl: "",
  maxAttendees: 0,
  signupOpen: true,
  // Unknown until the real config arrives, and false is the safe guess: it only
  // hides "the cloud" as a record destination, never offers one that 503s.
  cloudRecordingEnabled: false,
  recordingsRetentionDays: 30,
  emailConfigured: false,
  // 180 minutes = 3 hours, matches the server default.
  defaultMaxMeetingMin: 180,
  /* Empty rather than a copy of the server's list. The catalogue is what the
   * admin screen renders switches from, and a hardcoded one here would offer a
   * switch this build's API does not know about — better no switches for the
   * second before the real config lands than a wrong one. */
  featureCatalogue: [],
};

const ConfigContext = createContext<AppConfig>(CONFIG_FALLBACK);

/** Whether useAppConfig() is the real config yet: "ready" once the server
 *  render or the client fetch supplied it, "loading" while CONFIG_FALLBACK's
 *  guesses are standing in, "failed" when the API could not be reached. */
export type ConfigStatus = "loading" | "ready" | "failed";

const ConfigStatusContext = createContext<ConfigStatus>("ready");

export function useAppConfig(): AppConfig {
  return useContext(ConfigContext);
}

export function useAppConfigStatus(): ConfigStatus {
  return useContext(ConfigStatusContext);
}

/* The browser's own origin, read through useSyncExternalStore.
 *
 * It cannot be read during a server render and it never changes afterwards, so
 * the "store" has nothing to subscribe to — but going through this hook is what
 * gives the server a defined snapshot ("") instead of a hydration mismatch. */
const subscribeNothing = () => () => {};
const readOrigin = () => window.location.origin;
const readOriginOnServer = () => "";
const readHydrated = () => true;
const readNotHydrated = () => false;

/** The public URL to build share links from. Falls back to this browser's own
 *  origin, which is right in every single-origin deployment and never produces a
 *  link pointing at somebody else's domain. */
export function useShareOrigin(): string {
  const { webBaseUrl } = useAppConfig();
  const origin = useSyncExternalStore(
    subscribeNothing,
    readOrigin,
    readOriginOnServer,
  );
  return webBaseUrl || origin;
}

// ------------------------------------------------------------------ session

export type SessionStatus = "loading" | "anonymous" | "signed-in";

type SessionValue = {
  account: Account | null;
  status: SessionStatus;
  signIn: (email: string, password: string) => Promise<Account>;
  signUp: (input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    org?: string;
    title?: string;
  }) => Promise<SignupResponse>;
  signOut: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<Account>;
  requestHost: (phone?: string) => Promise<Account>;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside <AppProviders>");
  }
  return value;
}

// ------------------------------------------------------------------- toasts

export type Toast = {
  id: number;
  message: string;
  tone: "info" | "ok" | "error";
  /** Set for a toast placed with `upsert`, which the caller updates in place. */
  key?: string;
  /** Custom content, drawn instead of `message` inside the toast's own card. */
  node?: ReactNode;
  /** The node has buttons of its own, so the toast is not one big dismiss button. */
  interactive?: boolean;
  /** On its way out: drawn fading for a beat, then removed. */
  leaving?: boolean;
  onDismiss?: () => void;
  /** Announced assertively rather than politely. For "you have lost the room", not news. */
  urgent?: boolean;
};

export type KeyedToast = {
  /** Plain text for the fallback card — also what a custom node should say. */
  message: string;
  tone?: Toast["tone"];
  node?: ReactNode;
  /** The node has its own buttons (and its own close): drawn in a plain wrapper
   *  instead of a click-anywhere-to-close button, which could not contain them. */
  interactive?: boolean;
  /** Called when the person clicks it away (not when the caller dismisses it). */
  onDismiss?: () => void;
  urgent?: boolean;
};

type ToastValue = {
  toasts: Toast[];
  notify: (message: string, tone?: Toast["tone"]) => void;
  dismiss: (id: number) => void;
  /** Show or update the toast with this key, in place. It stays until the caller
   *  calls `dismissKey` — keyed toasts have a lifecycle of their own (a join that is
   *  still in progress), so there is no timer here to fight it. */
  upsert: (key: string, toast: KeyedToast) => void;
  dismissKey: (key: string) => void;
};

const ToastContext = createContext<ToastValue | null>(null);

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used inside <AppProviders>");
  }
  return value;
}

const TOAST_MS = 4500;
/** Long enough for the fade in globals.css (toast-out) to finish. */
const TOAST_LEAVE_MS = 200;

// ------------------------------------------------------------------ provider

export function AppProviders({
  children,
  initialConfig,
}: {
  children: ReactNode;
  /** Fetched during the server render so the product name never flashes. */
  initialConfig?: AppConfig | null;
}) {
  const [config, setConfig] = useState<AppConfig>(initialConfig ?? CONFIG_FALLBACK);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>(initialConfig ? "ready" : "loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const nextToastId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Marks the toast as leaving and removes it once the fade has run. The timer map
  // holds either its auto-dismiss or its removal, never both.
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    setToasts((current) => current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((current) => current.filter((t) => t.id !== id || !t.leaving));
      }, TOAST_LEAVE_MS),
    );
  }, []);

  const notify = useCallback(
    (message: string, tone: Toast["tone"] = "info") => {
      const id = ++nextToastId.current;
      setToasts((current) => [...current, { id, message, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      );
    },
    [dismiss],
  );

  // Keyed toasts keep their id — and so their place in the stack and their DOM node —
  // across updates, which is what lets "joining…" turn into "joined" rather than one
  // toast vanishing as another appears.
  const keyed = useRef(new Map<string, number>());

  const upsert = useCallback((key: string, toast: KeyedToast) => {
    let id = keyed.current.get(key);
    if (id !== undefined) {
      const pending = timers.current.get(id);
      if (pending) {
        clearTimeout(pending);
        timers.current.delete(id);
      }
    } else {
      id = ++nextToastId.current;
      keyed.current.set(key, id);
    }
    const next: Toast = {
      id,
      key,
      message: toast.message,
      tone: toast.tone ?? "info",
      node: toast.node,
      interactive: toast.interactive,
      onDismiss: toast.onDismiss,
      urgent: toast.urgent,
    };
    setToasts((current) =>
      current.some((t) => t.id === id)
        ? current.map((t) => (t.id === id ? next : t))
        : [...current, next],
    );
  }, []);

  const dismissKey = useCallback(
    (key: string) => {
      const id = keyed.current.get(key);
      if (id === undefined) return;
      keyed.current.delete(key);
      dismiss(id);
    },
    [dismiss],
  );

  // Clear pending timers on unmount so a toast cannot fire into a dead tree.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (isDevAuthBypass()) {
      if (isDevAuthBypassActive()) {
        setAccount(DEV_BYPASS_ACCOUNT);
        setStatus("signed-in");
      } else {
        setAccount(null);
        setStatus("anonymous");
      }
      return;
    }
    try {
      const me = await api.me(true);
      setAccount(me);
      setStatus("signed-in");
    } catch (err) {
      // A 401 is the normal answer for a visitor. Anything else means the API is
      // unreachable, which is also "not signed in" as far as the UI can act.
      if (!(err instanceof ApiError)) {
        console.error("session lookup failed", err);
      }
      setAccount(null);
      setStatus("anonymous");
    }
  }, []);

  // Local preview settles the session from sessionStorage, which the server
  // cannot read. That happens during the first render after hydration rather
  // than in the effect below; status never returns to "loading", so it runs once.
  const hydrated = useSyncExternalStore(subscribeNothing, readHydrated, readNotHydrated);
  if (hydrated && status === "loading" && isDevAuthBypass()) {
    if (isDevAuthBypassActive()) {
      setAccount(DEV_BYPASS_ACCOUNT);
      setStatus("signed-in");
    } else {
      setAccount(null);
      setStatus("anonymous");
    }
  }

  // The promise chain is inline rather than a call to `refresh`, so every state
  // write happens in a callback instead of synchronously inside the effect.
  useEffect(() => {
    if (isDevAuthBypass()) return;
    let active = true;
    api
      .me()
      .then((me) => {
        if (!active) return;
        setAccount(me);
        setStatus("signed-in");
      })
      .catch(() => {
        if (!active) return;
        setAccount(null);
        setStatus("anonymous");
      });
    return () => {
      active = false;
    };
  }, []);

  // The server render already fetched config. Seeding the 5-minute cache skips
  // the extra client refetch; a later read within that window is the same answer.
  useEffect(() => {
    if (initialConfig) {
      writeCache("/api/config", initialConfig);
      return;
    }
    let active = true;
    api
      .config()
      .then((c) => {
        if (!active) return;
        setConfig(c);
        setConfigStatus("ready");
      })
      .catch(() => {
        // Keep whatever we already have. The shell must still render.
        if (active) setConfigStatus((s) => (s === "loading" ? "failed" : s));
      });
    return () => {
      active = false;
    };
  }, [initialConfig]);

  const session = useMemo<SessionValue>(
    () => ({
      account,
      status,
      signIn: async (email, password) => {
        const me = await api.login(email, password);
        writeCache("/api/auth/me", me);
        setAccount(me);
        setStatus("signed-in");
        return me;
      },
      signUp: async (input) => api.signup(input),
      signOut: async () => {
        if (isDevAuthBypass()) {
          // Opt out of the fake host session for this tab (sessionStorage + cookie).
          setDevBypassOptedOut(true);
          setAccount(null);
          setStatus("anonymous");
          return;
        }
        try {
          await api.logout();
        } finally {
          // Drop local state even if the request failed: the cookie may already
          // be gone, and leaving a stale avatar in the nav is worse.
          dropCache("/api/auth/me");
          setAccount(null);
          setStatus("anonymous");
        }
      },
      updateProfile: async (patch) => {
        if (isDevAuthBypassActive()) {
          const next = { ...DEV_BYPASS_ACCOUNT, ...patch } as Account;
          setAccount(next);
          return next;
        }
        const me = await api.updateProfile(patch);
        dropCache("/api/auth/me");
        writeCache("/api/auth/me", me);
        setAccount(me);
        return me;
      },
      requestHost: async (phone) => {
        if (isDevAuthBypassActive()) {
          return account ?? DEV_BYPASS_ACCOUNT;
        }
        const me = await api.requestHost(phone);
        dropCache("/api/auth/me");
        writeCache("/api/auth/me", me);
        setAccount(me);
        return me;
      },
      refresh,
    }),
    [account, status, refresh],
  );

  const toastValue = useMemo<ToastValue>(
    () => ({ toasts, notify, dismiss, upsert, dismissKey }),
    [toasts, notify, dismiss, upsert, dismissKey],
  );

  return (
    <ConfigContext.Provider value={config}>
      <ConfigStatusContext.Provider value={configStatus}>
        <SessionContext.Provider value={session}>
          <ToastContext.Provider value={toastValue}>
            <ThemeProvider>
              {children}
              <ToastViewport />
            </ThemeProvider>
          </ToastContext.Provider>
        </SessionContext.Provider>
      </ConfigStatusContext.Provider>
    </ConfigContext.Provider>
  );
}

const toastTone: Record<Toast["tone"], string> = {
  info: "border-line-2 bg-surface text-ink",
  ok: "border-ok/30 bg-ok-soft text-ok",
  error: "border-live/30 bg-live-soft text-live",
};

function ToastViewport() {
  const { toasts, dismiss, dismissKey } = useToast();

  const close = (t: Toast) => {
    t.onDismiss?.();
    if (t.key) dismissKey(t.key);
    else dismiss(t.id);
  };

  /* Both live regions are rendered even when empty: a region that appears together with
   * its first message is often not announced at all. An urgent toast is announced through
   * the assertive one and muted in the polite stack (aria-live="off" on its item), so it is
   * said once, immediately — while its card, and any button on it, stays in the tree. */
  const urgent = toasts.filter((t) => t.urgent && !t.leaving);

  return (
    <>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {urgent.map((t) => (
          <p key={t.id}>{t.message}</p>
        ))}
      </div>
      {/* Above the room's own overlays, and inset-x on small screens so a long
          message wraps instead of running off the side of a phone. */}
      <div
        className="toast-viewport pointer-events-none fixed inset-x-3 z-[100] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) =>
          t.node && t.interactive ? (
            // The card has buttons of its own, and a button inside a button is not a
            // button anybody can press — so this one is a plain box.
            <div
              key={t.id}
              aria-live={t.urgent ? "off" : undefined}
              className={`toast-item pointer-events-auto w-full max-w-sm text-left sm:w-auto ${t.leaving ? "toast-leaving" : ""}`}
            >
              {t.node}
            </div>
          ) : t.node ? (
            // The custom card draws its own surface; this is only the click target.
            // tabIndex -1: a toast arriving must never pull focus or join the tab order
            // in the middle of somebody presenting.
            <button
              key={t.id}
              type="button"
              tabIndex={-1}
              aria-live={t.urgent ? "off" : undefined}
              onClick={() => close(t)}
              className={`toast-item pointer-events-auto w-full max-w-sm text-left sm:w-auto ${t.leaving ? "toast-leaving" : ""}`}
            >
              {t.node}
            </button>
          ) : (
            <button
              key={t.id}
              onClick={() => close(t)}
              className={`toast-item pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-2.5 text-left text-[13px] font-medium shadow-lg backdrop-blur transition-opacity hover:opacity-90 sm:w-auto ${toastTone[t.tone]} ${t.leaving ? "toast-leaving" : ""}`}
            >
              {t.message}
            </button>
          ),
        )}
      </div>
    </>
  );
}
