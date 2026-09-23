"use client";

/* Meta's Embedded Signup, from the browser's side.
 *
 * Connecting WhatsApp is not an OAuth redirect. Meta's JS SDK opens a popup in
 * which the host signs into their own Facebook Business account, picks or creates
 * a WhatsApp Business Account, and verifies a phone number. What comes back
 * arrives in TWO pieces, from two different channels, and both are needed:
 *
 *   FB.login callback   an authorization code, exchanged server-side for the
 *                       token that sends messages
 *   postMessage         which WABA and which phone number the host just granted
 *
 * Neither piece is derivable from the other, which is why this module waits for
 * both before resolving. A code alone would buy a token with nothing to send
 * from — a connection that looks complete in the UI and cannot message anybody.
 *
 * The SDK is loaded when the card mounts rather than when the button is pressed,
 * and that is deliberate: FB.login opens a popup, and a popup opened from an
 * async continuation is what Safari blocks. Preparing first means the click
 * handler calls FB.login synchronously, inside the gesture that granted it.
 * The cost is Meta's script on the account page for hosts of an instance where
 * this feature is switched on at all — nowhere else in the app.
 *
 * The token itself never touches this file. The code goes straight to our API,
 * which exchanges it with the app secret and stores the result against the host.
 */

import type { WhatsAppSignup } from "./api-types";

/** What the dialog produced, ready to post to our own API. */
export type WhatsAppGrant = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
};

/* Narrow declarations for the two globals the SDK installs, rather than pulling
 * in a types package for one dialog. Only the members used below, so a mistake
 * here is a compile error instead of an `any` that accepts anything. Same
 * approach as lib/drive.ts. */

type FBLoginResponse = {
  authResponse?: { code?: string } | null;
  status?: string;
};

type FBGlobal = {
  init: (opts: {
    appId: string;
    cookie?: boolean;
    xfbml?: boolean;
    version: string;
  }) => void;
  login: (
    cb: (response: FBLoginResponse) => void,
    opts: Record<string, unknown>,
  ) => void;
};

function fb(): FBGlobal | undefined {
  return (window as unknown as { FB?: FBGlobal }).FB;
}

/* Origins the signup dialog posts from. Checked on every message, because this
 * listener is the channel that decides which WhatsApp account we connect: a page
 * in another tab must not be able to name somebody else's WABA. */
const DIALOG_ORIGINS = [
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
];

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = loaded.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.crossOrigin = "anonymous";
    el.onload = () => resolve();
    el.onerror = () => {
      // Dropped from the cache so a retry is possible. The usual cause is an
      // extension or a network that blocks Facebook, which the host may well be
      // able to do something about.
      loaded.delete(src);
      reject(new Error("Couldn't reach Meta. Check the network and try again."));
    };
    document.head.appendChild(el);
  });
  loaded.set(src, promise);
  return promise;
}

/** Loads and initialises the SDK. Safe to call more than once: the script is
 *  cached and FB.init is idempotent for the same app. */
export async function prepareWhatsAppSignup(cfg: WhatsAppSignup): Promise<void> {
  await loadScript("https://connect.facebook.net/en_US/sdk.js");
  const sdk = fb();
  if (!sdk) throw new Error("Meta's sign-in script didn't load.");
  sdk.init({
    appId: cfg.appId,
    // No cookie and no XFBML parsing: this is one dialog, not a Facebook
    // login session for our own site, and nothing on the page is an FB tag.
    cookie: false,
    xfbml: false,
    // The same Graph version the API talks to — see wa.Client.Version.
    version: cfg.graphVersion,
  });
}

type SessionInfo = { wabaId?: string; phoneNumberId?: string };

function readSessionInfo(raw: unknown): SessionInfo | null {
  // The payload is a JSON string in some SDK versions and an object in others.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const msg = parsed as { type?: string; event?: string; data?: unknown };
  if (msg.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (!msg.data || typeof msg.data !== "object") return {};
  const data = msg.data as { waba_id?: unknown; phone_number_id?: unknown };
  return {
    wabaId: typeof data.waba_id === "string" ? data.waba_id : undefined,
    phoneNumberId:
      typeof data.phone_number_id === "string" ? data.phone_number_id : undefined,
  };
}

/* How long to keep waiting for the postMessage after the code has arrived.
 *
 * The dialog normally posts its session info BEFORE the login callback fires, so
 * this timer usually never starts. It exists for the reverse order, and it is
 * short because the alternative to giving up is a spinner that never stops. */
const SESSION_INFO_GRACE_MS = 4000;

/** Opens the dialog. Resolves null when the host closes it without finishing,
 *  which is an ordinary outcome and not an error to report as one.
 *
 *  Must be called from a click handler: it opens a popup. */
export function openWhatsAppSignup(
  cfg: WhatsAppSignup,
): Promise<WhatsAppGrant | null> {
  const sdk = fb();
  if (!sdk) {
    return Promise.reject(new Error("Meta's sign-in script didn't load."));
  }

  return new Promise<WhatsAppGrant | null>((resolve, reject) => {
    let session: SessionInfo = {};
    let code = "";
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      outcome: { ok: WhatsAppGrant | null } | { err: Error },
    ) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (graceTimer) clearTimeout(graceTimer);
      if ("err" in outcome) reject(outcome.err);
      else resolve(outcome.ok);
    };

    const tryComplete = () => {
      if (!code) return;
      if (session.wabaId && session.phoneNumberId) {
        finish({
          ok: {
            code,
            wabaId: session.wabaId,
            phoneNumberId: session.phoneNumberId,
          },
        });
        return;
      }
      graceTimer ??= setTimeout(() => {
        finish({
          err: new Error(
            "Meta didn't say which WhatsApp number was connected. Try again, and let the dialog finish before closing it.",
          ),
        });
      }, SESSION_INFO_GRACE_MS);
    };

    function onMessage(event: MessageEvent) {
      if (!DIALOG_ORIGINS.includes(event.origin)) return;
      const info = readSessionInfo(event.data);
      if (!info) return;
      session = { ...session, ...info };
      tryComplete();
    }

    window.addEventListener("message", onMessage);

    sdk.login(
      (response) => {
        const granted = response.authResponse?.code ?? "";
        if (!granted) {
          // Closed the popup, or declined. Not a failure.
          finish({ ok: null });
          return;
        }
        code = granted;
        tryComplete();
      },
      {
        config_id: cfg.configId,
        // A code, not an access token: the exchange happens on the API with the
        // app secret, so the browser never holds a credential that can send
        // messages on the host's bill. override_default_response_type is what
        // makes the SDK honour that for an Embedded Signup configuration.
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "",
          // Version 3 is what carries waba_id and phone_number_id in the
          // postMessage above. Without it the dialog completes and tells us
          // nothing about what it connected.
          sessionInfoVersion: "3",
        },
      },
    );
  });
}
