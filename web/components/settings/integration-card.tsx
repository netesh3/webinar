"use client";

import { useState } from "react";
import { MaterialIcon } from "../icons";
import { Menu, Modal, Spinner } from "../controls";
import { Button, ButtonLink } from "../ui";
import { ApiError, api } from "@/lib/api";
import { baseFor } from "@/lib/http";
import type { IntegrationAction, IntegrationCard } from "@/lib/api-types";

const TONE: Record<string, string> = {
  wa: "bg-[#1fa855]",
  yt: "bg-[#e62117]",
  li: "bg-[#0a66c2]",
  tg: "bg-[#2aa3df]",
  gc: "bg-[#1a73e8]",
  ig: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]",
  mc: "bg-[#f2c200] text-[#241c15]",
  zp: "bg-[#ff4f00]",
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
  const actions = card.actions ?? [];
  const primary = actions.find((a) => !a.menu);
  const menu = actions.filter((a) => a.menu);

  async function run(action: IntegrationAction) {
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
      className={`flex flex-col rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(19,22,25,0.04)] ${
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
            onClick={() => void run(primary)}
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
              onSelect: () => void run(action),
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
