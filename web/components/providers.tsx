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
import type { Account, AppConfig, ProfilePatch } from "@/lib/api-types";
import { DEV_BYPASS_ACCOUNT, isDevAuthBypass } from "@/lib/dev-bypass";
import {
  isDevAuthBypassActive,
  setDevBypassOptedOut,
} from "@/lib/dev-bypass-session";

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
  tracks: [],
  // Unknown until the real config arrives, and false is the safe guess: it only
  // hides "the cloud" as a record destination, never offers one that 503s.
  cloudRecordingEnabled: false,
  recordingsRetentionDays: 30,
  // 180 minutes = 3 hours, matches the server default.
  defaultMaxMeetingMin: 180,
};

const ConfigContext = createContext<AppConfig>(CONFIG_FALLBACK);

export function useAppConfig(): AppConfig {
  return useContext(ConfigContext);
}

/* The browser's own origin, read through useSyncExternalStore.
 *
 * It cannot be read during a server render and it never changes afterwards, so
 * the "store" has nothing to subscribe to — but going through this hook is what
 * gives the server a defined snapshot ("") instead of a hydration mismatch. */
const subscribeNothing = () => () => {};
const readOrigin = () => window.location.origin;
const readOriginOnServer = () => "";

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
  }) => Promise<Account>;
  signOut: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<Account>;
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

export type Toast = { id: number; message: string; tone: "info" | "ok" | "error" };

type ToastValue = {
  toasts: Toast[];
  notify: (message: string, tone?: Toast["tone"]) => void;
  dismiss: (id: number) => void;
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
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const nextToastId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
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
      const me = await api.me();
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

  // The promise chain is inline rather than a call to `refresh`, so every state
  // write happens in a callback instead of synchronously inside the effect.
  useEffect(() => {
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

  // Config is refreshed on the client even when the server already provided it:
  // the track suggestions grow as webinars are scheduled.
  useEffect(() => {
    let active = true;
    api
      .config()
      .then((c) => {
        if (active) setConfig(c);
      })
      .catch(() => {
        // Keep whatever we already have. The shell must still render.
      });
    return () => {
      active = false;
    };
  }, []);

  const session = useMemo<SessionValue>(
    () => ({
      account,
      status,
      signIn: async (email, password) => {
        const me = await api.login(email, password);
        setAccount(me);
        setStatus("signed-in");
        return me;
      },
      signUp: async (input) => {
        const me = await api.signup(input);
        setAccount(me);
        setStatus("signed-in");
        return me;
      },
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
        setAccount(me);
        return me;
      },
      refresh,
    }),
    [account, status, refresh],
  );

  const toastValue = useMemo<ToastValue>(
    () => ({ toasts, notify, dismiss }),
    [toasts, notify, dismiss],
  );

  return (
    <ConfigContext.Provider value={config}>
      <SessionContext.Provider value={session}>
        <ToastContext.Provider value={toastValue}>
          {children}
          <ToastViewport />
        </ToastContext.Provider>
      </SessionContext.Provider>
    </ConfigContext.Provider>
  );
}

const toastTone: Record<Toast["tone"], string> = {
  info: "border-line-2 bg-surface text-ink",
  ok: "border-ok/30 bg-ok-soft text-ok",
  error: "border-live/30 bg-live-soft text-live",
};

function ToastViewport() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;

  return (
    // Above the room's own overlays, and inset-x on small screens so a long
    // message wraps instead of running off the side of a phone.
    <div
      className="toast-viewport pointer-events-none fixed inset-x-3 z-[100] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-2.5 text-left text-[13px] font-medium shadow-lg backdrop-blur transition-opacity hover:opacity-90 sm:w-auto ${toastTone[t.tone]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
