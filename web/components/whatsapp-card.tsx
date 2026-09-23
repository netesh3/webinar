"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Spinner } from "./controls";
import { Button } from "./ui";
import { WhatsAppIcon } from "./icons";
import { ApiError, api } from "@/lib/api";
import { FeatureWhatsAppRegister } from "@/lib/api-types";
import type { Account, WhatsAppSignup } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import {
  openWhatsAppSignup,
  prepareWhatsAppSignup,
  type WhatsAppGrant,
} from "@/lib/whatsapp-signup";

/* Connect WhatsApp, in Account settings.
 *
 * The copy is blunt about billing on purpose. A host is connecting THEIR OWN
 * WhatsApp Business Account, and Meta charges every conversation to it — so the
 * card says so before they click, not in a help page afterwards. Somebody who
 * discovers that arrangement from a Meta invoice has been misled by omission,
 * however accurate everything else was.
 *
 * Its own file rather than another branch inside account-screen: the Embedded
 * Signup dialog needs Meta's SDK prepared on mount (see lib/whatsapp-signup.ts),
 * which is an effect and a piece of state that have nothing to do with editing a
 * name and an organisation.
 */
export function WhatsAppCard({
  account,
  onChanged,
}: {
  account: Account;
  /** Re-reads the session, so the card re-renders from the server's answer rather
   *  than from a guess about what the server did. */
  onChanged: () => Promise<void> | void;
}) {
  const connected = account.whatsapp?.connected ?? false;

  const [signup, setSignup] = useState<WhatsAppSignup | null>(null);
  // Bumped by Retry, which is the only way out of a blocked script or a network
  // that could not reach Meta a moment ago.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the component is gone, so a slow dialog resolving afterwards does
  // not set state on an unmounted card.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* Meta's SDK is loaded before the host clicks, not after.
   *
   * FB.login opens a popup, and a popup opened from an async continuation is what
   * Safari blocks — so by the time there is a button to press, the SDK has to be
   * ready for a synchronous call. Skipped entirely for an already-connected host:
   * there is nothing left to open.
   */
  useEffect(() => {
    if (connected) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.whatsappSignup();
        await prepareWhatsAppSignup(cfg);
        if (!cancelled) setSignup(cfg);
      } catch (err) {
        if (cancelled) return;
        // Not shown as an error on arrival: a host who came here to change their
        // name should not be met with a red box about a feature they did not ask
        // for. The button reports it when they try to use it.
        setSignup(null);
        setError(
          err instanceof ApiError
            ? err.message
            : "WhatsApp isn't available right now.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, attempt]);

  const connect = useCallback(async () => {
    if (!signup) return;
    setError(null);
    setNotice(null);
    let grant: WhatsAppGrant | null = null;
    try {
      // Synchronous inside the click: see the effect above.
      grant = await openWhatsAppSignup(signup);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not connect WhatsApp.",
      );
      return;
    }
    // Closed the dialog without finishing. An ordinary outcome, and not worth a
    // message of its own.
    if (!grant) return;

    setBusy(true);
    try {
      await api.connectWhatsApp(grant);
      await onChanged();
      if (alive.current) {
        setNotice(
          "WhatsApp connected. Messages you send from here are billed to your own WhatsApp Business account by Meta.",
        );
      }
    } catch (err) {
      if (alive.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not finish connecting WhatsApp.",
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [onChanged, signup]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.disconnectWhatsApp();
      await onChanged();
      if (alive.current) setNotice("WhatsApp disconnected.");
    } catch (err) {
      if (alive.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not disconnect WhatsApp.",
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [onChanged]);

  const number = account.whatsapp?.displayPhone;
  const business = account.whatsapp?.verifiedName;

  return (
    <div className="grid gap-2.5 rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[13px] font-medium">
            <WhatsAppIcon className="size-4" />
            WhatsApp
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
            {connected
              ? `Connected${number ? ` as ${number}` : ""}${business ? ` (${business})` : ""}. Meta bills conversations to this WhatsApp Business account — yours, not ours.`
              : "Connect your own WhatsApp Business account to message registrants. Meta bills every conversation to that account, at their rates, using the payment method on it — we never charge you for messages and never send from our number."}
          </div>
        </div>
        {connected ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={disconnect}
          >
            {busy ? <Spinner className="size-4" /> : "Disconnect"}
          </Button>
        ) : !signup && error ? (
          // Preparation failed — a blocked script, a network that could not reach
          // Meta. A dead disabled button would leave no way forward.
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        ) : (
          <Button
            type="button"
            // Disabled until Meta's SDK is ready, because a click before that
            // cannot open the dialog at all.
            disabled={busy || !signup}
            onClick={connect}
          >
            {busy || !signup ? <Spinner className="size-4" /> : null}
            Connect
          </Button>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      {connected && (account.features ?? []).includes(FeatureWhatsAppRegister) && (
        <RegisterNumber account={account} onChanged={onChanged} />
      )}
    </div>
  );
}

/* Registering the number with Cloud API, with a PIN the host chooses.
 *
 * Part of connecting rather than a screen of its own, because that is when it
 * matters: a number created inside the Embedded Signup dialog cannot send
 * anything until it has been registered, and a host who does not do it here
 * discovers the problem when their first reminder fails.
 *
 * The PIN is the host's. They type it, it goes out in one request, and it is
 * dropped from this component the moment the request succeeds — not kept in
 * state, not put in localStorage, not logged. This application cannot tell them
 * what it was later, which is deliberate: the place to reset it is Meta's own
 * two-step verification settings, on their account.
 */
function RegisterNumber({
  account,
  onChanged,
}: {
  account: Account;
  onChanged: () => Promise<void> | void;
}) {
  const registeredAt = account.whatsapp?.registeredAt;
  const [pin, setPin] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Exactly six digits, and checked again by the server and by Meta — this only
  // saves a round trip on a PIN that was never going to be one.
  const valid = /^\d{6}$/.test(pin);
  const showForm = open || !registeredAt;

  async function register() {
    setBusy(true);
    setError(null);
    try {
      await api.registerWhatsAppNumber(pin);
      // Cleared before anything else happens with it. The host has it; we do not
      // need it again, and holding it would only widen where it can leak from.
      setPin("");
      setOpen(false);
      setDone(true);
      await onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not register that number with WhatsApp.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-line pt-2.5">
      <div className="text-[12px] leading-relaxed text-ink-2">
        {registeredAt
          ? `This number was registered for sending ${formatRelative(registeredAt, new Date())}.`
          : "A number created in the WhatsApp dialog has to be registered before it can send. Meta asks for a six-digit two-step verification PIN to do it — choose one and keep it: we never store it, and only Meta can reset it."}
      </div>

      {showForm ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void register();
          }}
        >
          <input
            className="field w-28 text-center font-mono tracking-[0.3em]"
            value={pin}
            // Digits only as they type, rather than a refusal afterwards: a
            // pasted "419 357" is the PIN the host meant.
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            // Off, not "one-time-code": this is a PIN the host chose, and it has
            // no business being saved by a password manager on our say-so.
            autoComplete="off"
            aria-label="Six-digit two-step verification PIN"
            placeholder="······"
          />
          <Button type="submit" disabled={busy || !valid}>
            {busy ? <Spinner className="size-4" /> : null}
            Register number
          </Button>
          {registeredAt && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPin("");
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          )}
        </form>
      ) : (
        <div>
          <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
            Register again
          </Button>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {done && !error && (
        <Alert tone="ok">
          This number is registered and can send. Keep your PIN somewhere safe.
        </Alert>
      )}
    </div>
  );
}
