"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import type { Account } from "@/lib/api-types";
import { useSession } from "./providers";
import { Button, Card } from "./ui";

/* One request, two places: the signed-in home (/browse) and Settings.
 *
 * The button is hidden for someone who already hosts. A phone is asked for
 * only when the account does not have one. After the request is recorded the
 * same control says so, on a refresh as well as on the click that sent it.
 */

function phoneProblem(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return "Required.";
  if (digits.length < 8) {
    return "That number looks too short — include the country code.";
  }
  if (digits.length > 15) return "That number is too long.";
  return null;
}

export function HostRequest({
  account,
  placement,
}: {
  account: Account;
  placement: "home" | "settings";
}) {
  const { requestHost, refresh } = useSession();
  const [asking, setAsking] = useState(false);
  const [phone, setPhone] = useState("");
  const [field, setField] = useState<string | null>(null);
  const [already, setAlready] = useState(false);
  const [busy, setBusy] = useState(false);

  if (account.canHost) return null;

  const hasPhone = account.phone.trim() !== "";
  const sent = Boolean(account.hostRequestedAt);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!hasPhone) {
      const problem = phoneProblem(phone);
      if (problem) {
        setField(problem);
        setAsking(true);
        return;
      }
    }
    setBusy(true);
    setField(null);
    try {
      await requestHost(hasPhone ? undefined : phone.trim());
      setAsking(false);
      setAlready(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "host_request_exists") {
        setAlready(true);
        await refresh();
        return;
      }
      if (err instanceof ApiError && err.fields?.phone) {
        setField(err.fields.phone);
        setAsking(true);
      } else {
        setField(
          err instanceof ApiError ? err.message : "Could not send the request.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function onAsk() {
    if (hasPhone) {
      void submit();
      return;
    }
    setAsking(true);
  }

  const sentCopy = already
    ? "Your hosting request is already in."
    : "Request sent. An administrator still has to turn hosting on.";

  const body =
    sent || already ? (
      <p className="text-[12.5px] leading-relaxed text-ink-2">{sentCopy}</p>
    ) : asking && !hasPhone ? (
      <form onSubmit={submit} className="grid gap-2">
        <label
          className="text-[12.5px] text-ink-2"
          htmlFor={`host-request-phone-${placement}`}
        >
          Mobile number, with country code
        </label>
        <input
          id={`host-request-phone-${placement}`}
          className={`field ${field ? "border-live" : ""}`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={Boolean(field)}
        />
        {field && <p className="text-[12px] font-medium text-live">{field}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy} size="sm">
            {busy ? "Sending…" : "Send request"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAsking(false);
              setField(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    ) : (
      <div className="grid gap-2">
        <p
          className={
            placement === "home"
              ? "text-[13px] leading-relaxed text-ink-2"
              : "text-[12px] leading-relaxed text-ink-2"
          }
        >
          {placement === "home"
            ? "Want to run your own webinars? Request hosting and we'll review your account."
            : "Request hosting for this account. Hosting stays off until an administrator turns it on."}
        </p>
        {field && <p className="text-[12px] font-medium text-live">{field}</p>}
        <div>
          <Button
            type="button"
            onClick={onAsk}
            disabled={busy}
            size={placement === "settings" ? "sm" : "md"}
          >
            {busy ? "Sending…" : "Request to host"}
          </Button>
        </div>
      </div>
    );

  if (placement === "settings") return body;

  return (
    <Card className="mb-6 p-5">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">
        Request to host
      </h2>
      <div className="mt-2">{body}</div>
    </Card>
  );
}
