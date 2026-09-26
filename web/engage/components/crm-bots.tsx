"use client";

import { engageApi } from "../api";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, ConfirmModal, Select, Spinner, Toggle } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Badge, Button, Card, Empty } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  BotAnyMessage,
  BotKeyword,
  BotMaxButtonLabel,
  BotMaxButtons,
  BotMaxNodes,
  BotMaxText,
  BotNodeAsk,
  BotNodeEnroll,
  BotNodeHandoff,
  BotNodeMessage,
  BotNodeTag,
  BotNodeWait,
} from "@/lib/api-types";
import type {
  CRMBot,
  CRMBotNode,
  CRMBotSequence,
  CRMBotSession,
  CRMTag,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Bots — the flow that answers a WhatsApp message while the host is asleep.
 *
 * Everything else in this CRM sends because a host pressed something. A bot sends
 * because somebody wrote in, which makes two things worth more space than they would
 * otherwise get:
 *
 *   - a new bot starts paused, and pausing is offered before deleting. A flow that is
 *     answering people wrongly is a live problem, and the fix has to be one press that
 *     does not also throw the flow away.
 *   - the conversations it has had are shown with where they stopped and why. A stack
 *     of sessions ending at the same question is the only honest review of a flow, and
 *     "handed to a person" versus "the 24-hour window closed" are different problems.
 *
 * The builder is a list of steps rather than a canvas. Each step says what it does and
 * which step comes next, and the branches are the buttons on a question — which is the
 * whole of the graph, without the part where a host drags a line and misses.
 *
 * None of the rules are enforced here. The server refuses a flow with a missing edge, a
 * loop, an over-long button or somebody else's sequence in it, and the runtime re-checks
 * consent, the service window and a step budget before every send. This only tries not
 * to offer what would be refused.
 */

/** How often a bot with live conversations re-reads itself, while the tab is being
 *  looked at. Sleeping flows are woken by a 30-second sweep on the server, so
 *  positions move with nobody clicking anything. */
const POLL_MS = 20_000;

const TRIGGER_LABELS: Record<string, string> = {
  [BotAnyMessage]: "Anybody who writes in",
  [BotKeyword]: "Only messages with these words",
};

/** The same rules, short enough for a row in the list. */
const TRIGGER_SHORT: Record<string, string> = {
  [BotAnyMessage]: "Any message",
  [BotKeyword]: "On a keyword",
};

/** What each kind of step does, in the host's words. The server's vocabulary is
 *  `message`/`ask`/`wait`/`enroll`/`set_tag`/`handoff`; nobody has to learn it. */
const KIND_LABELS: Record<string, string> = {
  [BotNodeMessage]: "Say something",
  [BotNodeAsk]: "Ask a question",
  [BotNodeWait]: "Wait",
  [BotNodeEnroll]: "Add to a sequence",
  /* The one step nothing is sent by, which is why it is worded as a note to the
   * host rather than as something the contact experiences: it is how an answer to
   * a question becomes a label, and how "press 2 for pricing" ends up on a list. */
  [BotNodeTag]: "Put a tag on them",
  [BotNodeHandoff]: "Hand over to me",
};

const STATE_LABELS: Record<string, string> = {
  waiting: "Waiting for an answer",
  sleeping: "Paused mid-flow",
  done: "Finished the flow",
  handoff: "With a person",
  stopped: "Stopped",
};

/** Why a conversation ended, spelled out. The server's codes are deliberately
 *  narrow — see CRMBotSession.endedReason — and each one is a different thing for
 *  the host to do about it, or to ignore. */
const REASON_LABELS: Record<string, string> = {
  handed_over: "handed over by the flow",
  host_took_over: "you took it over",
  window_closed: "WhatsApp's 24 hours ran out before it could reply",
  node_missing: "the flow was edited while they were in it",
  too_many_steps: "it hit the step limit",
  opted_out: "they opted out",
  bot_off: "the bot was paused",
  send_failed: "WhatsApp refused a message",
  whatsapp_disconnected: "WhatsApp was disconnected",
};

export function Bots({ whatsappConnected }: { whatsappConnected: boolean }) {
  const { notify } = useToast();
  const [bots, setBots] = useState<CRMBot[] | null>(null);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [sequences, setSequences] = useState<CRMBotSequence[]>([]);
  /** What a `set_tag` step may point at. Empty when that step is not offered,
   *  which is the same condition — the server decides both. */
  const [tags, setTags] = useState<CRMTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The flow being written: a fresh one, or the one being edited. */
  const [editing, setEditing] = useState<CRMBot | "new" | null>(null);
  const [deleting, setDeleting] = useState<CRMBot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmBots()
      .then((res) => {
        if (cancelled) return;
        setBots(res.bots);
        setTriggers(res.triggers);
        setKinds(res.nodeKinds);
        setSequences(res.sequences);
        setTags(res.tags);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBots([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your bots.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /* Polled only while somebody is actually in a conversation with one. A host
   * reading a paused bot, or one nobody has written to, is reading numbers that
   * will not change on their own. */
  const live = (bots ?? []).some(
    (b) => b.active && b.stats.waiting + b.stats.sleeping > 0,
  );

  useEffect(() => {
    if (!live || editing !== null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [live, editing, refresh]);

  /* Pausing is a full save, because a bot is written as a whole — see the PUT in
   * lib/api.ts. Worth the round trip for how often it is the right answer: nobody
   * new is answered, and anybody mid-flow stops at their next step rather than
   * being left half-asked. */
  async function setActive(bot: CRMBot, active: boolean) {
    setBusy(bot.id);
    try {
      const saved = await engageApi.updateCrmBot(bot.id, {
        name: bot.name,
        trigger: bot.trigger,
        keywords: bot.keywords,
        entry: bot.entry,
        active,
        nodes: bot.nodes,
      });
      setBots((prev) =>
        (prev ?? []).map((b) => (b.id === saved.bot.id ? saved.bot : b)),
      );
      notify(
        active
          ? "Answering again — the next message that matches starts a conversation."
          : "Paused. Nobody new is answered, and anybody mid-flow stops at their next step.",
        "ok",
      );
    } catch (e: unknown) {
      /* The server's own sentence. "You already have a bot answering every
       * message" is the one that happens, and it names the thing to change. */
      notify(
        e instanceof ApiError ? e.message : "Could not change that bot.",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    try {
      await engageApi.deleteCrmBot(deleting.id);
      setBots((prev) => (prev ?? []).filter((b) => b.id !== deleting.id));
      setDeleting(null);
      notify("Bot deleted.", "ok");
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not delete that bot.",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  if (bots === null) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (editing !== null) {
    return (
      <div className="grid gap-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Builder
          bot={editing === "new" ? null : editing}
          triggers={triggers}
          kinds={kinds}
          sequences={sequences}
          tags={tags}
          whatsappConnected={whatsappConnected}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setBots((prev) => {
              const list = prev ?? [];
              return list.some((b) => b.id === saved.id)
                ? list.map((b) => (b.id === saved.id ? saved : b))
                : [saved, ...list];
            });
            setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}

      {whatsappConnected && bots.length > 0 && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => setEditing("new")}>
            New bot
          </Button>
        </div>
      )}

      {bots.length === 0 ? (
        <Empty
          title="No bots yet"
          hint="A bot answers somebody who writes to your WhatsApp number: it can reply, ask a question with buttons, put them on a sequence, and hand the conversation to you when it runs out of answers. It only ever replies inside the 24 hours their own message opens, so nothing it sends costs you a template."
          action={
            whatsappConnected ? (
              <Button type="button" onClick={() => setEditing("new")}>
                New bot
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3">
          {bots.map((b) => (
            <BotRow
              key={b.id}
              bot={b}
              busy={busy === b.id}
              whatsappConnected={whatsappConnected}
              onEdit={() => setEditing(b)}
              onToggle={(active) => setActive(b, active)}
              onDelete={() => setDeleting(b)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        busy={busy !== null}
        title="Delete this bot?"
        body="Anybody part-way through a conversation with it stops there, and the record of who it has talked to goes with it. Messages already sent stay in their conversations. Pausing it instead keeps all of that."
        confirmLabel="Delete bot"
      />
    </div>
  );
}

// --------------------------------------------------------------------- list

function BotRow({
  bot: b,
  busy,
  whatsappConnected,
  onEdit,
  onToggle,
  onDelete,
}: {
  bot: CRMBot;
  busy: boolean;
  whatsappConnected: boolean;
  onEdit: () => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const s = b.stats;

  return (
    <Card className="grid gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium">{b.name}</span>
            {b.active ? (
              <Badge tone="ok" dot>
                Answering
              </Badge>
            ) : (
              <Badge tone="warn">Paused</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {TRIGGER_SHORT[b.trigger] ?? b.trigger}
            {b.trigger === BotKeyword && (b.keywords ?? []).length > 0
              ? `: ${(b.keywords ?? []).join(", ")}`
              : ""}{" "}
            · {b.nodes.length === 1 ? "1 step" : `${b.nodes.length} steps`}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            Created {formatRelative(b.createdAt, new Date())}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Pause before delete, and in that order on purpose: it is what a host
              who has just read a reply their bot sent actually wants. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !whatsappConnected}
            onClick={() => onToggle(!b.active)}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : b.active ? (
              "Pause"
            ) : (
              "Switch on"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!whatsappConnected}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {/* Live conversations first: they are the ones the bot is in the middle of,
          and the only ones a host can still do something about. */}
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
        <Stat label="waiting for an answer" value={s.waiting} always />
        <Stat label="mid-flow" value={s.sleeping} />
        <Stat label="finished" value={s.done} />
        <Stat label="handed to you" value={s.handedOff} />
        <Stat label="stopped" value={s.stopped} tone="live" />
      </dl>

      <Flow bot={b} />

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide the conversations" : "Show the conversations"}
        </Button>
      </div>
      {open && <Sessions bot={b} />}
    </Card>
  );
}

/** The flow as a list, starting at the step a conversation starts at. The reading
 *  order is the builder's, not the graph's — a host checking a bot is looking for
 *  the step they wrote, and it is where they left it. */
function Flow({ bot }: { bot: CRMBot }) {
  return (
    <ol className="grid gap-1.5 border-l border-line pl-3 text-[12px]">
      {bot.nodes.map((node, i) => (
        <li key={node.key} className="grid gap-0.5">
          <span className="text-ink-3">
            {node.key === bot.entry ? "Starts here" : `Step ${i + 1}`} ·{" "}
            {KIND_LABELS[node.kind] ?? node.kind}
          </span>
          <span className="text-ink-2">{summaryOf(node, bot)}</span>
        </li>
      ))}
    </ol>
  );
}

function Stat({
  label,
  value,
  always = false,
  tone,
}: {
  label: string;
  value: number;
  always?: boolean;
  tone?: "live";
}) {
  if (value === 0 && !always) return null;
  return (
    <div className="flex items-baseline gap-1">
      <dt className="sr-only">{label}</dt>
      <dd
        className={`text-[13px] font-semibold ${tone === "live" ? "text-live" : ""}`}
      >
        {value}
      </dd>
      <span aria-hidden className="text-ink-3">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- sessions

/* Who has been through the flow, where they got to, and why it ended.
 *
 * Read on demand rather than with the list, for the reason the sequences screen gives:
 * this is a view of who it talked to, not an export of it, and a host with four bots is
 * not asking about four sets of conversations at once.
 */
function Sessions({ bot }: { bot: CRMBot }) {
  const [rows, setRows] = useState<CRMBotSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmBot(bot.id)
      .then((res) => {
        if (cancelled) return;
        setRows(res.sessions);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load this bot's conversations.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  if (rows === null) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-ink-3">
        <Spinner className="size-3.5" />
        Loading…
      </p>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      {error && <Alert tone="warn">{error}</Alert>}

      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          {bot.active
            ? "Nobody yet. A conversation starts the next time somebody writes in and matches."
            : "Nobody yet — this bot is paused, so nothing it would answer is being answered."}
        </p>
      ) : (
        <ul className="grid divide-y divide-line">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px]">
                  {row.contactName || row.phone || "Somebody"}
                </p>
                <p className="text-[11.5px] text-ink-3">
                  {placeText(row, bot)}
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-ink-3">
                {formatRelative(row.updatedAt, new Date())}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ builder

/** How a step being written is held: exactly the shape the API stores, keys and
 *  all. There is nothing to convert — unlike a sequence's waits, every field of a
 *  node is edited as it is sent — and keeping the keys stable is what lets an edge
 *  survive the step it points at being moved. */
type Draft = CRMBotNode;

/** The sentinel for "this is where the conversation ends" in an edge picker. Empty
 *  is what the API stores, and an empty `<option value>` is a real choice a select
 *  can be on. */
const ENDS = "";

function Builder({
  bot,
  triggers,
  kinds,
  sequences,
  tags,
  whatsappConnected,
  onClose,
  onSaved,
}: {
  bot: CRMBot | null;
  triggers: string[];
  kinds: string[];
  sequences: CRMBotSequence[];
  /** For a `set_tag` step. Empty when the account has no tags, in which case that
   *  kind is not in `kinds` either and no card can be added that needs it. */
  tags: CRMTag[];
  whatsappConnected: boolean;
  onClose: () => void;
  onSaved: (bot: CRMBot) => void;
}) {
  const { notify } = useToast();
  const [name, setName] = useState(bot?.name ?? "");
  const [trigger, setTrigger] = useState(bot?.trigger ?? BotKeyword);
  const [keywords, setKeywords] = useState((bot?.keywords ?? []).join(", "));
  /* A new bot starts paused, and deliberately: a bot is the one thing here that
   * sends without the host present, and the flow has not been read back yet.
   * Switching it on is one press, underneath the finished steps. */
  const [active, setActive] = useState(bot?.active ?? false);
  const [nodes, setNodes] = useState<Draft[]>(() =>
    (bot?.nodes ?? []).map((n) => ({ ...n })),
  );
  const [entry, setEntry] = useState(bot?.entry ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = parseKeywords(keywords);

  function setNode(key: string, change: Partial<Draft>) {
    setNodes((prev) =>
      prev.map((n) => (n.key === key ? { ...n, ...change } : n)),
    );
  }

  function addNode(kind: string) {
    const node: Draft = { key: freshKey(nodes), kind };
    if (kind === BotNodeAsk) node.buttons = [{ label: "" }];
    if (kind === BotNodeWait) node.delayMinutes = 60;
    if (kind === BotNodeEnroll) node.dripId = sequences[0]?.id ?? "";
    /* Prefilled with the host's first tag, the same as a sequence above: a step
     * that applies a label is never useful with no label, and the one thing it
     * must not do is silently apply the wrong one — so the picker shows what was
     * filled in, rather than a blank that saves as nothing. */
    if (kind === BotNodeTag) node.tagId = tags[0]?.id ?? "";
    setNodes((prev) => {
      /* Chained onto the end, because a flow is written top to bottom and the step
       * just added is almost always what comes next. The step before is only
       * relinked when it was ending the conversation — never over an edge the host
       * chose. */
      const before = prev[prev.length - 1];
      const linked =
        before && !before.next && before.kind !== BotNodeAsk
          ? prev.map((n) =>
              n.key === before.key ? { ...n, next: node.key } : n,
            )
          : prev;
      return [...linked, node];
    });
    // The first step is where a conversation starts, until the host says otherwise.
    setEntry((prev) => prev || node.key);
  }

  /* Removing a step takes its edges with it. The alternative is a saved flow the
   * server refuses ("goes to a step that is not there any more") for a reason the
   * host cannot see from the form. */
  function removeNode(key: string) {
    setNodes((prev) =>
      prev
        .filter((n) => n.key !== key)
        .map((n) => ({
          ...n,
          next: n.next === key ? ENDS : n.next,
          buttons: n.buttons?.map((btn) =>
            btn.next === key ? { ...btn, next: ENDS } : btn,
          ),
        })),
    );
    setEntry((prev) =>
      prev === key ? (nodes.find((n) => n.key !== key)?.key ?? "") : prev,
    );
  }

  /* Changing a step's kind keeps everything typed into it. A host switching a
   * message to a question has not changed their mind about the words, and the
   * fields a kind does not use are ignored by the server rather than stored. */
  function setKind(key: string, kind: string) {
    const node = nodes.find((n) => n.key === key);
    if (!node || node.kind === kind) return;
    const change: Partial<Draft> = { kind };
    if (kind === BotNodeAsk && (node.buttons ?? []).length === 0) {
      change.buttons = [{ label: "" }];
    }
    if (kind === BotNodeWait && !node.delayMinutes) change.delayMinutes = 60;
    if (kind === BotNodeEnroll && !node.dripId) {
      change.dripId = sequences[0]?.id ?? "";
    }
    if (kind === BotNodeTag && !node.tagId) {
      change.tagId = tags[0]?.id ?? "";
    }
    setNode(key, change);
  }

  function setButton(key: string, i: number, label: string, next?: string) {
    const node = nodes.find((n) => n.key === key);
    if (!node) return;
    setNode(key, {
      buttons: (node.buttons ?? []).map((btn, j) =>
        j === i ? { label, next: next === undefined ? btn.next : next } : btn,
      ),
    });
  }

  /* One sentence rather than a disabled button with nothing to read. In the order
   * the form is filled in, so the first thing still missing is the one named, and
   * in the same words the server would use for the same refusal. */
  const blocker = !whatsappConnected
    ? "Connect your own WhatsApp Business account to build a bot."
    : !name.trim()
      ? "Name the bot, so you can tell it from the next one."
      : trigger === BotKeyword && words.length === 0
        ? "List at least one word that starts it — a message has to match one of them."
        : words.some((word) => word.length > 64)
          ? "A keyword can be at most 64 characters."
          : words.length > 20
            ? "At most 20 keywords."
            : nodes.length === 0
              ? "Add the first step."
              : nodes.length > BotMaxNodes
                ? `A bot can have at most ${BotMaxNodes} steps.`
                : (stepProblem(nodes, sequences, tags) ??
                  (!entry || !nodes.some((n) => n.key === entry)
                    ? "Say which step a conversation starts at."
                    : loopAt(nodes, entry)
                      ? `Step ${indexOf(nodes, loopAt(nodes, entry))} leads back to itself, so this bot would keep messaging the same person.`
                      : null));

  async function save() {
    if (blocker) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        trigger,
        keywords: trigger === BotKeyword ? words : undefined,
        entry,
        active,
        nodes: nodes.map(clean),
      };
      const res = bot
        ? await engageApi.updateCrmBot(bot.id, body)
        : await engageApi.createCrmBot(body);
      setError(null);
      notify(
        res.bot.active
          ? bot
            ? "Saved. Anybody mid-conversation carries on with the new flow."
            : "Bot answering. The next message that matches starts a conversation."
          : "Saved, and paused — switch it on when you are happy with it.",
        "ok",
      );
      onSaved(res.bot);
    } catch (e: unknown) {
      /* The server's own sentence, which names the step: "Step 3: a question needs
       * at least one button" is the difference between fixing it and guessing. */
      const message =
        e instanceof ApiError ? e.message : "Could not save that bot.";
      setError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="grid gap-3.5 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">
            {bot ? "Edit bot" : "New bot"}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Answers from your own WhatsApp number, inside the 24 hours the
            person&apos;s own message opens — so nothing a bot sends needs an
            approved template.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {bot ? "Cancel" : "Discard"}
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {/* Said before the steps, because it is the thing about editing a live bot
          that is easy to get wrong and impossible to take back. */}
      {bot && bot.stats.waiting + bot.stats.sleeping > 0 && (
        <Alert tone="warn">
          {bot.stats.waiting + bot.stats.sleeping === 1
            ? "1 person is part-way through this flow"
            : `${bot.stats.waiting + bot.stats.sleeping} people are part-way through this flow`}
          . They carry on with the flow as you save it, and anybody sitting on a
          step you remove is stopped where they are.
        </Alert>
      )}

      <div>
        <label className="label" htmlFor="bot-name">
          Name it, for your own list
        </label>
        <input
          id="bot-name"
          className="field"
          placeholder="Front desk"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-[11.5px] text-ink-3">
          Only you see this. Nothing in it is sent to anybody.
        </p>
      </div>

      <Select
        label="When it answers"
        id="bot-trigger"
        value={trigger}
        onChange={setTrigger}
        hint="Either way it only answers somebody it is not already in a conversation with, and never somebody who replied STOP or whose conversation you have taken over."
      >
        {(triggers.length > 0 ? triggers : Object.keys(TRIGGER_LABELS)).map(
          (t) => (
            <option key={t} value={t}>
              {TRIGGER_LABELS[t] ?? t}
            </option>
          ),
        )}
      </Select>

      {trigger === BotKeyword && (
        <div>
          <label className="label" htmlFor="bot-keywords">
            The words that start it
          </label>
          <input
            id="bot-keywords"
            className="field"
            placeholder="price, pricing, how much"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Separated by commas, and matched anywhere in the message whatever
            the capitals.
          </p>
        </div>
      )}

      {/* Only one active catch-all per host, which the server enforces — two bots
          on "any message" would both match every message. Said here rather than
          waiting for the 409. */}
      {trigger === BotAnyMessage && (
        <Alert tone="warn">
          A bot that answers every message is the only one you can have running
          at a time. Switching this one on pauses nothing automatically — saving
          it active while another catch-all is running is refused.
        </Alert>
      )}

      <div className="grid gap-3">
        {nodes.map((node, i) => (
          <div
            key={node.key}
            className="grid gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-medium">
                Step {i + 1}
                {node.key === entry && (
                  <span className="ml-2 font-normal text-ink-3">
                    where a conversation starts
                  </span>
                )}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeNode(node.key)}
              >
                Remove
              </Button>
            </div>

            <Select
              label="What it does"
              id={`bot-kind-${node.key}`}
              value={node.kind}
              onChange={(next) => setKind(node.key, next)}
            >
              {(kinds.length > 0 ? kinds : Object.keys(KIND_LABELS)).map(
                (k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k] ?? k}
                  </option>
                ),
              )}
            </Select>

            {(node.kind === BotNodeMessage ||
              node.kind === BotNodeAsk ||
              node.kind === BotNodeHandoff) && (
              <div>
                <label className="label" htmlFor={`bot-text-${node.key}`}>
                  {node.kind === BotNodeHandoff
                    ? "What it says before handing over, if anything"
                    : "What it says"}
                </label>
                <textarea
                  id={`bot-text-${node.key}`}
                  className="field min-h-16 resize-y py-2"
                  maxLength={BotMaxText}
                  placeholder={
                    node.kind === BotNodeAsk
                      ? "What would you like to know about?"
                      : node.kind === BotNodeHandoff
                        ? "One moment — I'll get somebody to help."
                        : "Thanks for writing in!"
                  }
                  value={node.text ?? ""}
                  onChange={(e) => setNode(node.key, { text: e.target.value })}
                />
                <p className="mt-1 text-[11.5px] text-ink-3">
                  {(node.text ?? "").length} of {BotMaxText} characters.
                  {node.kind === BotNodeHandoff
                    ? " Leave it empty and the conversation is handed over without a word."
                    : ""}
                </p>
              </div>
            )}

            {node.kind === BotNodeAsk && (
              <div className="grid gap-2">
                {(node.buttons ?? []).map((btn, j) => (
                  <div key={j} className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label
                        className="label"
                        htmlFor={`bot-button-${node.key}-${j}`}
                      >
                        {`Button ${j + 1}`}
                      </label>
                      <input
                        id={`bot-button-${node.key}-${j}`}
                        className="field"
                        maxLength={BotMaxButtonLabel}
                        placeholder={j === 0 ? "Prices" : "Something else"}
                        value={btn.label}
                        onChange={(e) => setButton(node.key, j, e.target.value)}
                      />
                    </div>
                    <EdgePicker
                      label="Then go to"
                      id={`bot-button-next-${node.key}-${j}`}
                      nodes={nodes}
                      value={btn.next ?? ENDS}
                      exclude={node.key}
                      onChange={(next) =>
                        setButton(node.key, j, btn.label, next)
                      }
                    />
                  </div>
                ))}

                <div className="flex flex-wrap items-center gap-2">
                  {(node.buttons ?? []).length < BotMaxButtons && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setNode(node.key, {
                          buttons: [...(node.buttons ?? []), { label: "" }],
                        })
                      }
                    >
                      Add a button
                    </Button>
                  )}
                  {(node.buttons ?? []).length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setNode(node.key, {
                          buttons: (node.buttons ?? []).slice(0, -1),
                        })
                      }
                    >
                      Remove the last button
                    </Button>
                  )}
                  <p className="text-[11.5px] text-ink-3">
                    {BotMaxButtons} buttons at most, {BotMaxButtonLabel}{" "}
                    characters each — WhatsApp&apos;s limits.
                  </p>
                </div>
              </div>
            )}

            {node.kind === BotNodeWait && (
              <div className="sm:max-w-48">
                <label className="label" htmlFor={`bot-delay-${node.key}`}>
                  Wait, in minutes
                </label>
                <input
                  id={`bot-delay-${node.key}`}
                  className="field"
                  type="number"
                  min={0}
                  max={24 * 60}
                  value={node.delayMinutes ?? 0}
                  onChange={(e) =>
                    setNode(node.key, {
                      delayMinutes: Math.max(0, e.target.valueAsNumber || 0),
                    })
                  }
                />
                <p className="mt-1 text-[11.5px] text-ink-3">
                  24 hours at most: WhatsApp closes the window a day after their
                  last message, and a flow that slept through it cannot reply.
                </p>
              </div>
            )}

            {node.kind === BotNodeEnroll && (
              <Select
                label="Which sequence"
                id={`bot-drip-${node.key}`}
                value={node.dripId ?? ""}
                onChange={(next) => setNode(node.key, { dripId: next })}
                hint="They join it once, and only if they have opted in to WhatsApp — the sequence checks that itself."
              >
                <option value="">Choose a sequence…</option>
                {sequences.map((seq) => (
                  <option key={seq.id} value={seq.id}>
                    {seq.name}
                  </option>
                ))}
              </Select>
            )}

            {node.kind === BotNodeTag && (
              <Select
                label="Which tag"
                id={`bot-tag-${node.key}`}
                value={node.tagId ?? ""}
                onChange={(next) => setNode(node.key, { tagId: next })}
                hint="Nothing is sent, and the contact is not told. If a sequence starts on this tag, putting it on here starts that sequence too."
              >
                <option value="">Choose a tag…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}

            {node.kind !== BotNodeHandoff && (
              <EdgePicker
                label={
                  node.kind === BotNodeAsk
                    ? "If the answer matches no button"
                    : "Then go to"
                }
                id={`bot-next-${node.key}`}
                nodes={nodes}
                value={node.next ?? ENDS}
                exclude={node.key}
                endsLabel={
                  node.kind === BotNodeAsk
                    ? "Hand the conversation over to me"
                    : "End the conversation"
                }
                onChange={(next) => setNode(node.key, { next })}
              />
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          {(kinds.length > 0 ? kinds : Object.keys(KIND_LABELS)).map((k) => (
            <Button
              key={k}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => addNode(k)}
            >
              {nodes.length === 0 && k === BotNodeMessage
                ? "Start with a message"
                : `Add: ${(KIND_LABELS[k] ?? k).toLowerCase()}`}
            </Button>
          ))}
        </div>
      </div>

      {nodes.length > 1 && (
        <EdgePicker
          label="A conversation starts at"
          id="bot-entry"
          nodes={nodes}
          value={entry}
          withEnd={false}
          onChange={setEntry}
        />
      )}

      <Toggle
        checked={active}
        onChange={setActive}
        label="Let this bot answer"
        description="Paused, nobody is answered and anybody mid-flow stops at their next step. Everything they have already been sent stays in their conversation."
      />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <Button
          type="button"
          onClick={save}
          disabled={saving || blocker !== null}
        >
          {saving && <Spinner className="size-3.5" />}
          {bot ? "Save bot" : "Create bot"}
        </Button>
      </div>

      {blocker ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">{blocker}</p>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          Every reply is checked again as it goes out: anybody who has opted
          out, or whose conversation you have taken over, is left alone — and a
          flow that runs out of time to reply stops rather than sending a
          template.
        </p>
      )}

      {!whatsappConnected && (
        <Alert tone="warn">
          Connect your own WhatsApp Business account in{" "}
          <Link href="/account" className="font-medium underline">
            account settings
          </Link>{" "}
          to build a bot.
        </Alert>
      )}
    </Card>
  );
}

/** A picker for one edge. Steps are offered by their number and what they do,
 *  because the key the API stores is generated and means nothing to anybody. */
function EdgePicker({
  label,
  id,
  nodes,
  value,
  exclude,
  endsLabel = "End the conversation",
  withEnd = true,
  onChange,
}: {
  label: string;
  id: string;
  nodes: Draft[];
  value: string;
  /** The step doing the pointing, which is never a choice: an edge to itself is
   *  the shortest possible loop, and the server refuses it. */
  exclude?: string;
  endsLabel?: string;
  withEnd?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <Select label={label} id={id} value={value} onChange={onChange}>
      {withEnd ? (
        <option value={ENDS}>{endsLabel}</option>
      ) : (
        /* A picker that cannot end the conversation still needs a choice for
         * "nothing yet", or a select with no matching option shows the first step
         * while holding none — and the host saves a flow starting somewhere they
         * did not pick. */
        !nodes.some((n) => n.key === value) && (
          <option value={ENDS}>Choose a step…</option>
        )
      )}
      {nodes.map((n, i) =>
        n.key === exclude ? null : (
          <option key={n.key} value={n.key}>
            {`Step ${i + 1} · ${KIND_LABELS[n.kind] ?? n.kind}`}
            {n.text ? ` · ${snippet(n.text)}` : ""}
          </option>
        ),
      )}
    </Select>
  );
}

// ------------------------------------------------------------------ helpers

/** A node as the API wants it: the fields its kind does not use dropped, so a
 *  question that used to be a wait does not travel with a stale delay on it. */
function clean(node: Draft): CRMBotNode {
  const out: CRMBotNode = { key: node.key, kind: node.kind };
  switch (node.kind) {
    case BotNodeMessage:
      out.text = (node.text ?? "").trim();
      out.next = node.next ?? ENDS;
      break;
    case BotNodeAsk:
      out.text = (node.text ?? "").trim();
      out.next = node.next ?? ENDS;
      out.buttons = (node.buttons ?? [])
        .filter((b) => b.label.trim() !== "")
        .map((b) => ({ label: b.label.trim(), next: b.next ?? ENDS }));
      break;
    case BotNodeWait:
      out.delayMinutes = node.delayMinutes ?? 0;
      out.next = node.next ?? ENDS;
      break;
    case BotNodeEnroll:
      out.dripId = node.dripId ?? "";
      out.next = node.next ?? ENDS;
      break;
    case BotNodeTag:
      out.tagId = node.tagId ?? "";
      out.next = node.next ?? ENDS;
      break;
    case BotNodeHandoff:
      // No edge: a handoff is the end of the flow by definition.
      out.text = (node.text ?? "").trim();
      break;
  }
  return out;
}

/** A key nothing else in this flow is using. Generated rather than asked for: it
 *  is never shown to a contact and never read by the host, and a name they typed
 *  would be one more thing to get wrong — see CRMBotNode.key. */
function freshKey(nodes: Draft[]): string {
  const used = new Set(nodes.map((n) => n.key));
  for (let n = nodes.length + 1; ; n++) {
    const key = `s${n}`;
    if (!used.has(key)) return key;
  }
}

function indexOf(nodes: Draft[], key: string): number {
  return nodes.findIndex((n) => n.key === key) + 1;
}

/** Everything one step can lead to, which is what makes the graph. Mirrors
 *  botEdges on the server. */
function edgesOf(node: Draft): string[] {
  const out: string[] = [];
  if (node.kind === BotNodeAsk) {
    for (const b of node.buttons ?? []) if (b.next) out.push(b.next);
  }
  if (node.next && node.kind !== BotNodeHandoff) out.push(node.next);
  return out;
}

/** The first step that leads back to itself, following the flow from its entry, or
 *  empty when there is none. The server refuses a loop; finding it here is what
 *  keeps that refusal from being the only way to hear about it.
 *
 *  Three-colour depth-first search, over the edges reachable from the entry only —
 *  the same rule the server applies, so a step left disconnected while the host
 *  rearranges the flow is not a reason to stop them saving. */
function loopAt(nodes: Draft[], entry: string): string {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const onPath = new Set<string>();

  function walk(key: string): string {
    if (onPath.has(key)) return key;
    if (seen.has(key)) return "";
    const node = byKey.get(key);
    if (!node) return "";
    seen.add(key);
    onPath.add(key);
    for (const edge of edgesOf(node)) {
      const loop = walk(edge);
      if (loop) return loop;
    }
    onPath.delete(key);
    return "";
  }

  return walk(entry);
}

/** The first step that cannot be saved, in the words the server would use for it.
 *  Only the rules that are worth saying before the round trip: a blank question, a
 *  button with nothing on it, a sequence not chosen. */
function stepProblem(
  nodes: Draft[],
  sequences: CRMBotSequence[],
  tags: CRMTag[],
): string | null {
  for (const [i, node] of nodes.entries()) {
    const at = `Step ${i + 1}: `;
    const text = (node.text ?? "").trim();
    if (
      (node.kind === BotNodeMessage || node.kind === BotNodeAsk) &&
      text === ""
    ) {
      return `${at}say something, or use a different kind of step.`;
    }
    if (node.kind === BotNodeAsk) {
      const labels = (node.buttons ?? [])
        .map((b) => b.label.trim())
        .filter((l) => l !== "");
      if (labels.length === 0) {
        return `${at}a question needs at least one button.`;
      }
      if (labels.length > BotMaxButtons) {
        return `${at}WhatsApp allows at most ${BotMaxButtons} buttons on a question.`;
      }
      const lower = labels.map((l) => l.toLowerCase());
      if (new Set(lower).size !== lower.length) {
        return `${at}two buttons say the same thing, so a typed answer could mean either.`;
      }
    }
    if (node.kind === BotNodeWait) {
      const minutes = node.delayMinutes ?? 0;
      if (minutes < 0 || minutes > 24 * 60) {
        return `${at}a bot can wait at most 24 hours — after that WhatsApp no longer allows a typed reply.`;
      }
    }
    if (node.kind === BotNodeEnroll) {
      if (!node.dripId) {
        return sequences.length === 0
          ? `${at}you have no sequences yet — write one under Sequences, or use a different kind of step.`
          : `${at}pick the sequence to put them on.`;
      }
    }
    if (node.kind === BotNodeTag) {
      if (!node.tagId) {
        return tags.length === 0
          ? `${at}you have no tags yet — make one under Tags on the Contacts tab, or use a different kind of step.`
          : `${at}pick the tag to put on them.`;
      }
    }
  }
  return null;
}

/** A keyword list as the host typed it: commas between the words, because a
 *  keyword can be a phrase and spaces cannot separate them. Lower-cased here as
 *  well as on the server, so the form reads back what will be matched. */
function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const word = part.trim().replace(/\s+/g, " ").toLowerCase();
    if (word !== "" && !out.includes(word)) out.push(word);
  }
  return out;
}

/** One step in a sentence, for the flow outline and the edge pickers. */
function summaryOf(node: CRMBotNode, bot: CRMBot): string {
  const goes = (key?: string) =>
    key ? ` → step ${indexOf(bot.nodes, key)}` : "";
  switch (node.kind) {
    case BotNodeAsk:
      return `“${snippet(node.text ?? "")}” · ${(node.buttons ?? [])
        .map((b) => `${b.label}${goes(b.next)}`)
        .join(" / ")}`;
    case BotNodeWait:
      return `${node.delayMinutes ?? 0} minutes${goes(node.next)}`;
    case BotNodeEnroll:
      return `${node.dripName || "a sequence that has since been deleted"}${goes(node.next)}`;
    case BotNodeTag:
      return `${node.tagName || "a tag that has since been deleted"}${goes(node.next)}`;
    case BotNodeHandoff:
      return node.text
        ? `“${snippet(node.text)}”, then it is yours`
        : "The conversation becomes yours";
    default:
      return `“${snippet(node.text ?? "")}”${goes(node.next)}`;
  }
}

function snippet(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
}

/** Where one conversation got to, in the words a host would use. The reason is the
 *  interesting half: a flow that stopped for somebody prompts exactly one question,
 *  and "WhatsApp's 24 hours ran out" is a different answer from "they opted out". */
function placeText(row: CRMBotSession, bot: CRMBot): string {
  const at = row.nodeKey ? indexOf(bot.nodes, row.nodeKey) : 0;
  const where = at > 0 ? ` at step ${at}` : "";
  const state = STATE_LABELS[row.state] ?? row.state;
  const why = row.endedReason
    ? ` — ${REASON_LABELS[row.endedReason] ?? row.endedReason}`
    : "";
  switch (row.state) {
    case "waiting":
    case "sleeping":
      return `${state}${where}`;
    case "done":
      return `${state}, ${row.steps === 1 ? "1 step" : `${row.steps} steps`}`;
    default:
      return `${state}${where}${why}`;
  }
}
