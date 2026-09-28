"use client";

import type { ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import type { CRMDrip, CRMRecipe } from "@/lib/api-types";
import { ruleSentence } from "./rule-builder";
import { Switch } from "./wa-kit";

/* Automatic replies, as sentences: when someone does something, WhatsApp does
 * something. The dialogs themselves stay the existing keyword and rule builders. */
export function WhatsAppReplies({
  rules,
  hot,
  keywords,
  connected,
  onToggleRule,
  onToggleRecipe,
  onKeywords,
  onAdd,
  onSequences,
  onBots,
  onBroadcasts,
}: {
  rules: CRMDrip[];
  hot: CRMRecipe | undefined;
  keywords: CRMRecipe | undefined;
  connected: boolean;
  onToggleRule: (drip: CRMDrip, active: boolean) => void;
  onToggleRecipe: (recipe: CRMRecipe, on: boolean) => void;
  onKeywords: () => void;
  onAdd: () => void;
  onSequences: () => void;
  onBots: () => void;
  onBroadcasts: () => void;
}) {
  return (
    <section className="grid gap-2.5">
      <div>
        <h2 className="text-[16px] font-semibold text-ink">Automatic replies</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-3">
          When someone does something, WhatsApp does something for you.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {rules.map((d) => {
          const r = ruleSentence(d);
          return (
            <ReplyRow
              key={d.id}
              icon="bolt"
              off={!d.active}
              text={
                <>
                  <span className="text-ink-3">When</span> {r.when}{" "}
                  <MaterialIcon name="arrow_forward" className="!text-[15px] text-ink-3" />{" "}
                  {r.then}
                </>
              }
              hint={d.name}
              right={
                <Switch
                  checked={d.active}
                  onChange={(v) => onToggleRule(d, v)}
                  label={d.name}
                  disabled={!connected && !d.active}
                />
              }
            />
          );
        })}
        {hot && (
          <ReplyRow
            icon="sell"
            off={!hot.active}
            text={
              <>
                <span className="text-ink-3">When someone asks about</span>{" "}
                {hot.words?.length ? hot.words.join(", ") : "price or your program"}{" "}
                <MaterialIcon name="arrow_forward" className="!text-[15px] text-ink-3" /> tag{" "}
                <b>Hot lead</b>
              </>
            }
            hint={hot.hint}
            right={
              <Switch
                checked={hot.active}
                onChange={(v) => onToggleRecipe(hot, v)}
                label="Tag hot leads"
                disabled={!connected}
              />
            }
          />
        )}
        {keywords && (
          <ReplyRow
            icon="chat"
            off={!keywords.configured || !keywords.active}
            text={
              <>
                <span className="text-ink-3">When someone sends</span>{" "}
                {keywords.keywords?.length ? (
                  keywords.keywords.map((k, i) => (
                    <span key={k.word}>
                      {i > 0 && <span className="text-ink-3"> or </span>}
                      <b>{k.word}</b>
                    </span>
                  ))
                ) : (
                  <>
                    <b>PRICE</b>
                    <span className="text-ink-3"> or </span>
                    <b>REPLAY</b>
                  </>
                )}{" "}
                <MaterialIcon name="arrow_forward" className="!text-[15px] text-ink-3" /> reply
                straight away
              </>
            }
            hint={keywords.hint || (keywords.configured ? "" : "Not set up yet")}
            right={
              keywords.configured ? (
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={onKeywords}
                    className="text-[12px] font-medium text-brand hover:underline"
                  >
                    Edit
                  </button>
                  <Switch
                    checked={keywords.active}
                    onChange={(v) => onToggleRecipe(keywords, v)}
                    label="Keyword replies"
                    disabled={!connected}
                  />
                </span>
              ) : (
                <Button size="sm" variant="secondary" onClick={onKeywords} disabled={!connected}>
                  Set up
                </Button>
              )
            }
          />
        )}
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={onAdd}
            disabled={!connected}
            className="inline-flex items-center text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
          >
            <MaterialIcon name="add" className="!text-[16px]" />
            Add an automatic reply
          </button>
        </div>
      </div>
      <p className="text-[12px] text-ink-3">
        One message to a group, once?{" "}
        <button type="button" onClick={onBroadcasts} className="font-medium text-brand hover:underline">
          Send a message now
        </button>
        {" · "}
        Something custom?{" "}
        <button type="button" onClick={onSequences} className="font-medium text-brand hover:underline">
          Sequences
        </button>{" "}
        and{" "}
        <button type="button" onClick={onBots} className="font-medium text-brand hover:underline">
          bots
        </button>
      </p>
    </section>
  );
}

function ReplyRow({
  icon,
  text,
  hint,
  off,
  right,
}: {
  icon: string;
  text: ReactNode;
  hint?: string;
  off?: boolean;
  right: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <span
        className={`grid size-[30px] shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2 ${
          off ? "opacity-60" : ""
        }`}
      >
        <MaterialIcon name={icon} className="!text-[18px]" />
      </span>
      <div className={`min-w-0 flex-1 text-[13.5px] text-ink ${off ? "opacity-60" : ""}`}>
        <p>{text}</p>
        {hint && <small className="mt-0.5 block text-[12px] text-ink-3">{hint}</small>}
      </div>
      {right}
    </div>
  );
}
