"use client";

import { useState, type FormEvent } from "react";
import { MaterialIcon } from "../icons";
import { Menu, Modal, Spinner } from "../controls";
import { Button, ButtonLink } from "../ui";
import { ApiError, api } from "@/lib/api";
import { interceptConnectClick } from "@/lib/app-connect";
import { baseFor } from "@/lib/http";
import type { IntegrationAction, IntegrationCard } from "@/lib/api-types";

const TONE: Record<string, string> = {
  wa: "bg-[#1fa855]",
  yt: "bg-[#e62117]",
  li: "bg-[#0a66c2]",
  fb: "bg-[#1877f2]",
  tg: "bg-[#2aa3df]",
  gc: "bg-[#1a73e8]",
  ig: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]",
  mc: "bg-[#f2c200] text-[#241c15]",
  zp: "bg-[#ff4f00]",
  zm: "bg-[#0b5cff]",
};

function Mark({ card, compact }: { card: IntegrationCard; compact?: boolean }) {
  const soon = card.status === "soon";
  return (
    <span
      className={`grid shrink-0 place-items-center text-white ${TONE[card.tone] ?? "bg-ink-3"} ${
        compact ? "size-[30px] rounded-lg text-[17px]" : "size-9 rounded-[9px] text-[20px]"
      } ${soon ? "opacity-80 saturate-[.55]" : ""} ${card.tone === "mc" ? "" : ""}`}
    >
      {card.text ? (
        <span className={`font-bold ${compact ? "text-[13px]" : "text-[15px]"}`}>{card.text}</span>
      ) : (
        <MaterialIcon name={card.mark} fill className={compact ? "!text-[17px]" : "!text-[20px]"} />
      )}
    </span>
  );
}

function Status({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap text-ok">
        <span className="size-[7px] rounded-full bg-ok" />
        Connected
      </span>
    );
  }
  if (status === "soon") {
    return (
      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-ink-3">
        Coming soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap text-ink-3">
      <span className="size-[7px] rounded-full bg-line-2" />
      Not connected
    </span>
  );
}

/** One integration, from the registry. The button and the ⋯ menu are whatever
 *  actions the API sent — this file does not know WhatsApp from YouTube. */
export function IntegrationCard({
  card,
  onChange,
}: {
  card: IntegrationCard;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<IntegrationAction | null>(null);
  const [confirm, setConfirm] = useState<IntegrationAction | null>(null);
  const [keyForm, setKeyForm] = useState<IntegrationAction | null>(null);
  const actions = card.actions ?? [];
  const primary = actions.find((a) => !a.menu);
  const menu = actions.filter((a) => a.menu);

  async function run(action: IntegrationAction) {
    if (action.kind === "stream_key") {
      setKeyForm(action);
      return;
    }
    if (action.kind === "info" || action.kind === "signup") {
      setDialog(action);
      return;
    }
    if (action.kind === "interest") {
      setBusy(true);
      setError(null);
      try {
        await api.integrationInterest(card.id);
        await onChange();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not save that.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (action.kind === "delete" && action.href?.startsWith("/api/")) {
      setBusy(true);
      setError(null);
      try {
        await api.integrationCall(action.href, "DELETE");
        await onChange();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not disconnect.");
      } finally {
        setBusy(false);
      }
    }
  }

  return (
    <article
      className={`flex h-full flex-col rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(19,22,25,0.04)] ${
        card.status === "soon" ? "text-ink-3" : ""
      }`}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5">
        <Mark card={card} />
        <div className="min-w-0 flex-1">
          <b className="block text-[14px] font-semibold text-ink">{card.name}</b>
          <span className="block text-[11.5px] text-ink-3">{card.tagline}</span>
        </div>
        <Status status={card.status} />
      </div>
      <p
        className={`flex-1 px-4 pt-2 pb-3.5 text-[12.5px] leading-relaxed ${
          card.status === "soon" ? "text-ink-3" : "text-ink-2"
        }`}
      >
        {card.detail}
      </p>
      <div className="flex min-h-[53px] items-center gap-2 border-t border-line px-4 py-2.5">
        <div className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
          {card.who && <b className="font-medium text-ink">{card.who}</b>}
          {card.whoNote && <small className="block text-[11.5px] text-ink-3">{card.whoNote}</small>}
          {card.warn && (
            <small className="mt-0.5 flex items-center gap-1 text-[11.5px] text-warn">
              <MaterialIcon name="schedule" className="!text-[13px]" />
              {card.warn}
            </small>
          )}
          {card.interested && !primary && (
            <small className="block text-[11.5px] text-ink-3">We&apos;ll email you the day it&apos;s ready.</small>
          )}
          {error && <small className="block text-[11.5px] text-live">{error}</small>}
        </div>
        {primary && primary.kind === "navigate" && primary.href ? (
          <ButtonLink href={primary.href} size="sm" variant="secondary">
            {primary.label}
          </ButtonLink>
        ) : primary?.kind === "redirect" && primary.href ? (
          <a
            href={`${baseFor()}${primary.href}`}
            // Inside the desktop or mobile app, the connect runs in the system browser.
            onClick={(e) => interceptConnectClick(e, primary.href!, setError)}
            className="inline-flex h-8 items-center justify-center rounded-lg bg-brand px-3 text-[12.5px] font-medium text-white hover:bg-brand-hover"
          >
            {primary.label}
          </a>
        ) : primary ? (
          <Button
            type="button"
            size="sm"
            variant={card.status === "connected" ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => {
              if (primary.confirm) setConfirm(primary);
              else void run(primary);
            }}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {primary.kind === "interest" && <MaterialIcon name="notifications" className="!text-[16px]" />}
            {primary.label}
          </Button>
        ) : null}
        {menu.length > 0 && (
          <Menu
            label={`${card.name} actions`}
            align="end"
            items={menu.map((action) => ({
              kind: "action" as const,
              label: action.label,
              danger: action.kind === "delete",
              onSelect: () => {
                if (action.confirm) setConfirm(action);
                else void run(action);
              },
            }))}
            trigger={
              <span className="grid size-8 place-items-center rounded-lg border border-line-2 bg-surface text-ink-2">
                <MaterialIcon name="more_horiz" className="!text-[18px]" />
              </span>
            }
          />
        )}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.label && confirm.label !== "Disconnect" ? `${confirm.label} ${card.name}?` : `Disconnect ${card.name}?`}
        description={confirm?.confirm}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action) void run(action);
              }}
            >
              {confirm?.label || "Disconnect"}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">{confirm?.confirm}</p>
      </Modal>

      {keyForm && (
        <StreamKeyDialog
          card={card}
          action={keyForm}
          onClose={() => setKeyForm(null)}
          onSaved={async () => {
            setKeyForm(null);
            await onChange();
          }}
        />
      )}

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.kind === "signup" ? `Connect ${card.name}` : card.name}
        description={dialog?.kind === "signup" ? "Three steps. Nothing to copy or paste." : undefined}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            {dialog?.kind === "signup" && dialog.href && (
              <ButtonLink href={dialog.href} size="sm">
                Continue
              </ButtonLink>
            )}
          </div>
        }
      >
        {dialog?.steps && dialog.steps.length > 0 ? (
          <ol className="grid gap-3 sm:grid-cols-3">
            {dialog.steps.map((step, i) => (
              <li key={step.title} className="rounded-lg bg-surface-2 px-3 py-2.5">
                <span className="grid size-[22px] place-items-center rounded-full bg-brand text-[11.5px] font-semibold text-white">
                  {i + 1}
                </span>
                <b className="mt-2 block text-[13px]">{step.title}</b>
                <p className="mt-1 text-[12px] leading-snug text-ink-2">{step.body}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {dialog?.detail && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{dialog.detail}</p>
        )}
      </Modal>
    </article>
  );
}

/* A Stream URL and key, saved once (LinkedIn Live). The key is a password field
 * and is never shown again: the card names the server and the key's last four
 * characters instead. */
function StreamKeyDialog({
  card,
  action,
  onClose,
  onSaved,
}: {
  card: IntegrationCard;
  action: IntegrationAction;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [streamUrl, setStreamUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const replacing = card.status === "connected";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!action.href) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api.saveStreamKey(action.href, { streamUrl: streamUrl.trim(), streamKey: streamKey.trim() });
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      else setError(err instanceof ApiError ? err.message : "Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "h-10 w-full rounded-lg border bg-surface px-3 text-[13px] outline-none focus:ring-2 focus:ring-brand/40";

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="lg"
      title={replacing ? `Change your ${card.name} key` : `Set up ${card.name}`}
      description={`Paste the Stream URL and Stream key ${card.name} shows. Every webinar you take live then streams there too.`}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={`stream-key-${card.id}`} disabled={busy || !streamUrl.trim() || !streamKey.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Save
          </Button>
        </div>
      }
    >
      {action.steps && action.steps.length > 0 && (
        <ol className="grid gap-3 sm:grid-cols-3">
          {action.steps.map((step, i) => (
            <li key={step.title} className="rounded-lg bg-surface-2 px-3 py-2.5">
              <span className="grid size-[22px] place-items-center rounded-full bg-brand text-[11.5px] font-semibold text-white">
                {i + 1}
              </span>
              <b className="mt-2 block text-[13px]">{step.title}</b>
              <p className="mt-1 text-[12px] leading-snug text-ink-2">{step.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form id={`stream-key-${card.id}`} onSubmit={save} className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <span className="text-[12.5px] font-medium text-ink">Stream URL</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            placeholder="rtmps://…"
            aria-invalid={Boolean(fields.streamUrl)}
            className={`${input} font-mono ${fields.streamUrl ? "border-live" : "border-line"}`}
          />
          {fields.streamUrl && <small className="text-[12px] text-live">{fields.streamUrl}</small>}
        </label>
        <label className="grid gap-1">
          <span className="text-[12.5px] font-medium text-ink">Stream key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={streamKey}
            onChange={(e) => setStreamKey(e.target.value)}
            placeholder={replacing ? "Paste the new key to replace the saved one" : "Paste the stream key"}
            aria-invalid={Boolean(fields.streamKey)}
            className={`${input} font-mono ${fields.streamKey ? "border-live" : "border-line"}`}
          />
          {fields.streamKey && <small className="text-[12px] text-live">{fields.streamKey}</small>}
        </label>
        <p className="text-[12px] leading-relaxed text-ink-3">
          Keep the key private — anyone with it can stream to your account. We store it securely and never show it
          again. You can pause it in any room.
        </p>
        {error && <small className="text-[12px] text-live">{error}</small>}
      </form>
    </Modal>
  );
}

export function SoonRow({ card }: { card: IntegrationCard }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2.5">
      <Mark card={card} compact />
      <div className="min-w-0">
        <b className="block text-[13px] font-semibold">{card.name}</b>
        <small className="block text-[11.5px] text-ink-3">{card.detail}</small>
      </div>
    </div>
  );
}
