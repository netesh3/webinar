"use client";

import { useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Select, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  DripAttended,
  DripButtonTap,
  DripKeywordIn,
  DripNoShow,
  DripPollAnswer,
  DripRegistered,
  DripStepMessage,
  DripStepNotify,
  DripStepTag,
  DripTagAdded,
  type CRMDrip,
  type CRMDripMatch,
  type CRMDripStep,
  type CRMMergeField,
  type CRMParam,
  type CRMTag,
  type CRMTemplate,
  type EngagementTier,
} from "@/lib/api-types";
import { templateKey } from "./crm-templates";
import { categoryWords, readable } from "./wa-messages";

/* "+ New automation": a rule written as When → Then, in plain choices. Saved as a
 * sequence (the engine that already waits, retries and respects opt-outs), so a rule is
 * also editable in the Sequences builder. */

type WhenId =
  | "poll"
  | "registers"
  | "comes"
  | "misses"
  | "group"
  | "button"
  | "word"
  | "tag";

const WHENS: { id: WhenId; label: string }[] = [
  { id: "poll", label: "answers a poll" },
  { id: "registers", label: "registers" },
  { id: "comes", label: "comes to a webinar" },
  { id: "misses", label: "misses a webinar" },
  { id: "group", label: "is in an engagement group" },
  { id: "button", label: "taps a button" },
  { id: "word", label: "sends a word" },
  { id: "tag", label: "gets a tag" },
];

const GROUPS: { id: EngagementTier; label: string }[] = [
  { id: "high", label: "Highly engaged" },
  { id: "engaged", label: "Engaged" },
  { id: "passive", label: "Passive" },
  { id: "risk", label: "At risk" },
];

type Step =
  | { kind: "wait"; minutes: number }
  | { kind: "send"; template: string; params: string[] }
  | { kind: "tag"; tagId: string }
  | { kind: "notify"; note: string };

const WAITS = [
  { m: 0, l: "no wait" },
  { m: 30, l: "30 minutes" },
  { m: 60, l: "1 hour" },
  { m: 180, l: "3 hours" },
  { m: 1440, l: "1 day" },
  { m: 2880, l: "2 days" },
  { m: 10080, l: "1 week" },
];

/** A rule's sentence, for the list: "When someone answers “Yes” to “…” → send …, tag …". */
export function ruleSentence(d: CRMDrip): { when: string; then: string } {
  const m = d.match;
  const when =
    d.trigger === DripPollAnswer
      ? m?.answer
        ? `someone answers “${m.answer}” to “${m.question}”`
        : `someone answers “${m?.question}”`
      : d.trigger === DripButtonTap
        ? `someone taps “${m?.text}”`
        : d.trigger === DripKeywordIn
          ? `someone sends “${m?.word}”`
          : d.trigger === DripRegistered
            ? "someone registers"
            : d.trigger === DripAttended
              ? d.tiers?.length
                ? `someone is ${d.tiers.map((t) => GROUPS.find((g) => g.id === t)?.label ?? t).join(" or ")}`
                : "someone comes to a webinar"
              : d.trigger === DripNoShow
                ? "someone misses a webinar"
                : d.trigger === DripTagAdded
                  ? `someone gets ${d.tagName ? `“${d.tagName}”` : "a tag"}`
                  : "you add someone";
  const parts = d.steps.map((s) =>
    s.kind === DripStepTag
      ? `tag ${s.tagName ? `“${s.tagName}”` : "them"}`
      : s.kind === DripStepNotify
        ? "tell me"
        : `send ${s.template.replace(/[_-]+/g, " ")}`,
  );
  return { when, then: parts.join(", ") || "—" };
}

export function RuleBuilder({
  templates,
  tags,
  fields,
  onClose,
  onSaved,
}: {
  templates: CRMTemplate[];
  tags: CRMTag[];
  fields: CRMMergeField[];
  onClose: () => void;
  onSaved: (d: CRMDrip) => void;
}) {
  const { notify } = useToast();
  const usable = templates.filter((t) => t.sendable);
  const [when, setWhen] = useState<WhenId>("poll");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [text, setText] = useState("");
  const [tiers, setTiers] = useState<EngagementTier[]>(["high"]);
  const [tagId, setTagId] = useState(tags[0]?.id ?? "");
  const [steps, setSteps] = useState<Step[]>(() => [
    { kind: "wait", minutes: 60 },
    {
      kind: "send",
      template: usable[0] ? templateKey(usable[0]) : "",
      params: Array.from(
        { length: usable[0]?.variables ?? 0 },
        (_, i) => ["first_name", "topic", "when", "host"][i] ?? "first_name",
      ),
    },
  ]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");

  const tpl = (key: string) => usable.find((t) => templateKey(t) === key);
  const defaultParams = (t: CRMTemplate | undefined) =>
    Array.from(
      { length: t?.variables ?? 0 },
      (_, i) => ["first_name", "topic", "when", "host"][i] ?? "first_name",
    );


  function update(i: number, s: Step) {
    setSteps((prev) => prev.map((x, j) => (j === i ? s : x)));
  }

  function trigger(): {
    trigger: string;
    match?: CRMDripMatch;
    tiers?: EngagementTier[];
    tagId?: string;
  } {
    switch (when) {
      case "poll":
        return { trigger: DripPollAnswer, match: { question, answer } };
      case "button":
        return { trigger: DripButtonTap, match: { text } };
      case "word":
        return { trigger: DripKeywordIn, match: { word: text } };
      case "registers":
        return { trigger: DripRegistered };
      case "comes":
        return { trigger: DripAttended };
      case "misses":
        return { trigger: DripNoShow };
      case "group":
        return { trigger: DripAttended, tiers };
      case "tag":
        return { trigger: DripTagAdded, tagId };
    }
  }

  /* Waits fold into the next step's delay; a trailing wait has nothing to delay. */
  function toSteps(): CRMDripStep[] {
    const out: CRMDripStep[] = [];
    let wait = 0;
    for (const s of steps) {
      if (s.kind === "wait") {
        wait += s.minutes;
        continue;
      }
      const base = {
        delayMinutes: wait,
        template: "",
        language: "",
        params: [] as CRMParam[],
      };
      if (s.kind === "send") {
        const t = tpl(s.template);
        out.push({
          ...base,
          kind: DripStepMessage,
          template: t?.name ?? "",
          language: t?.language ?? "",
          params: s.params.map((p) => ({ field: p })),
        });
      } else if (s.kind === "tag") {
        out.push({ ...base, kind: DripStepTag, tagId: s.tagId });
      } else {
        out.push({ ...base, kind: DripStepNotify, note: s.note });
      }
      wait = 0;
    }
    return out;
  }

  async function makeTag(i: number) {
    if (!newTag.trim()) return;
    try {
      const t = await engageApi.createCrmTag(newTag.trim());
      tags.push(t);
      update(i, { kind: "tag", tagId: t.id });
      setNewTag("");
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not create that tag.",
        "error",
      );
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const t = trigger();
      const auto = `When ${WHENS.find((w) => w.id === when)?.label}${
        when === "poll" && question
          ? `: ${question}`
          : when === "word" || when === "button"
            ? `: ${text}`
            : ""
      }`;
      const res = await engageApi.createCrmDrip({
        name: (name.trim() || auto).slice(0, 80),
        trigger: t.trigger,
        match: t.match,
        tiers: t.tiers,
        tagId: t.tagId,
        active: true,
        steps: toSteps(),
      });
      notify("Automation is on.", "ok");
      onSaved(res.drip);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-[12.5px] font-medium transition ${
      on
        ? "border-brand bg-brand-soft text-brand"
        : "border-line bg-surface text-ink-2 hover:text-ink"
    }`;

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="New automatic reply"
      description="Pick what someone does, then what WhatsApp does for you."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner className="size-3.5" />}
            Turn on
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        {error && <Alert tone="error">{error}</Alert>}

        <section className="grid gap-2">
          <b className="flex items-center gap-2 pt-1 text-[13.5px] text-ink">
            <i className="grid size-[22px] place-items-center rounded-full bg-brand text-[11.5px] font-semibold text-white not-italic">
              1
            </i>
            When someone…
          </b>
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {WHENS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={chip(when === w.id)}
                  onClick={() => setWhen(w.id)}
                >
                  {w.label}
                </button>
              ))}
            </div>
            {when === "poll" && (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <input
                  className="field h-9 text-[13px]"
                  placeholder="The poll's question, e.g. Want 1:1 coaching?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <input
                  className="field h-9 text-[13px]"
                  placeholder="Answer (any, if empty)"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
                <p className="text-[11.5px] text-ink-3 sm:col-span-2">
                  Matches that question in any webinar, case and spacing aside.
                </p>
              </div>
            )}
            {(when === "button" || when === "word") && (
              <input
                className="field h-9 max-w-md text-[13px]"
                placeholder={
                  when === "button"
                    ? "The button's text, e.g. Tell me more"
                    : "A word, e.g. price"
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
            {when === "group" && (
              <div className="flex flex-wrap gap-1.5">
                {GROUPS.map((g) => {
                  const on = tiers.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      className={chip(on)}
                      onClick={() =>
                        setTiers((p) =>
                          on ? p.filter((x) => x !== g.id) : [...p, g.id],
                        )
                      }
                    >
                      {g.label}
                    </button>
                  );
                })}
                <span className="self-center text-[11.5px] text-ink-3">
                  after each webinar is scored
                </span>
              </div>
            )}
            {when === "tag" && (
              <Select label="Tag" value={tagId} onChange={setTagId}>
                <option value="">Any tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </section>

        <section className="grid gap-2">
          <b className="flex items-center gap-2 pt-1 text-[13.5px] text-ink">
            <i className="grid size-[22px] place-items-center rounded-full bg-brand text-[11.5px] font-semibold text-white not-italic">
              2
            </i>
            Then…
          </b>
          <ol className="grid gap-2">
            {steps.map((s, i) => (
              <li
                key={i}
                className="flex flex-wrap items-start gap-2 rounded-xl border border-line px-3 py-2.5"
              >
                <span className="mt-1.5 grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
                  {i + 1}
                </span>
                {s.kind === "wait" && (
                  <div className="flex items-center gap-2 text-[13px]">
                    Wait
                    <select
                      className="field h-8 w-36 text-[12.5px]"
                      value={s.minutes}
                      onChange={(e) =>
                        update(i, {
                          kind: "wait",
                          minutes: Number(e.target.value),
                        })
                      }
                    >
                      {WAITS.map((w) => (
                        <option key={w.m} value={w.m}>
                          {w.l}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {s.kind === "send" && (
                  <div className="grid min-w-0 flex-1 gap-1">
                    <div className="flex items-center gap-2 text-[13px]">
                      Send
                      <select
                        className="field h-8 min-w-0 flex-1 text-[12.5px]"
                        value={s.template}
                        onChange={(e) =>
                          update(i, {
                            kind: "send",
                            template: e.target.value,
                            params: defaultParams(tpl(e.target.value)),
                          })
                        }
                      >
                        {usable.length === 0 && (
                          <option value="">No approved wording yet</option>
                        )}
                        {usable.map((t) => (
                          <option key={templateKey(t)} value={templateKey(t)}>
                            {t.name.replace(/[_-]+/g, " ")} ·{" "}
                            {categoryWords(t.category)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {tpl(s.template) && (
                      <p className="text-[12px] leading-relaxed text-ink-3">
                        {readable(
                          tpl(s.template)?.body ?? "",
                          s.params,
                          fields,
                        )}
                      </p>
                    )}
                  </div>
                )}
                {s.kind === "tag" && (
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    Tag them
                    <select
                      className="field h-8 w-44 text-[12.5px]"
                      value={s.tagId}
                      onChange={(e) =>
                        update(i, { kind: "tag", tagId: e.target.value })
                      }
                    >
                      <option value="">Pick a tag</option>
                      {tags.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field h-8 w-32 text-[12.5px]"
                      placeholder="or a new one"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        (e.preventDefault(), void makeTag(i))
                      }
                    />
                  </div>
                )}
                {s.kind === "notify" && (
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
                    Email me
                    <input
                      className="field h-8 min-w-0 flex-1 text-[12.5px]"
                      placeholder="A note for yourself (optional), e.g. Call them this week"
                      value={s.note}
                      onChange={(e) =>
                        update(i, { kind: "notify", note: e.target.value })
                      }
                    />
                  </div>
                )}
                <button
                  type="button"
                  aria-label="Remove this step"
                  className="ml-auto text-[12px] text-ink-3 hover:text-live"
                  onClick={() => setSteps((p) => p.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </li>
            ))}
            <li className="flex flex-wrap gap-1.5 text-[12.5px]">
              <span className="self-center text-ink-3">Add:</span>
              <button
                type="button"
                className={chip(false)}
                onClick={() =>
                  setSteps((p) => [...p, { kind: "wait", minutes: 1440 }])
                }
              >
                Wait
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() =>
                  setSteps((p) => [
                    ...p,
                    {
                      kind: "send",
                      template: usable[0] ? templateKey(usable[0]) : "",
                      params: defaultParams(usable[0]),
                    },
                  ])
                }
              >
                Send a message
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() =>
                  setSteps((p) => [
                    ...p,
                    { kind: "tag", tagId: tags[0]?.id ?? "" },
                  ])
                }
              >
                Tag them
              </button>
              <button
                type="button"
                className={chip(false)}
                onClick={() =>
                  setSteps((p) => [...p, { kind: "notify", note: "" }])
                }
              >
                Tell me
              </button>
            </li>
          </ol>
        </section>

        <section className="grid gap-2">
          <b className="flex items-center gap-2 pt-1 text-[13.5px] text-ink">
            <i className="grid size-[22px] place-items-center rounded-full bg-brand text-[11.5px] font-semibold text-white not-italic">
              3
            </i>
            Name it
            <span className="text-[11.5px] font-normal text-ink-3">optional</span>
          </b>
          <input
            className="field h-9 max-w-md text-[13px]"
            placeholder="Optional — we name it from the When"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </section>
        <p className="text-[11.5px] text-ink-3">
          Each person goes through a rule once. Messages only go to people who
          agreed to WhatsApp; tags and emails to you work for everyone.
        </p>
      </div>
    </Modal>
  );
}
