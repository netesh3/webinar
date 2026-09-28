"use client";

import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type {
  CRMRecipe,
  CRMRecipeKeyword,
  CRMRecipesResponse,
  CRMSetup,
} from "@/lib/api-types";
import { followupGroups } from "../buckets";
import { SendDialog, type Automate, type SendTarget } from "./send-dialog";
import { Switch } from "./wa-kit";

/* The WhatsApp page's Automations tab: ready-made recipes a coach turns on, instead of an
 * empty builder. Each is a preset over the drip and bot engines (see crm_recipes.go):
 * reminders, a follow-up after every webinar for each engagement group, keyword replies,
 * and tagging hot leads. The builders are still here, under "Build your own". */

export type BuildView = "sequences" | "bots" | "broadcasts";

const HINTS = Object.fromEntries(followupGroups().map((g) => [g.id, g.hints]));

export function Automations({
  setup,
  onOpenTemplates,
  onBuild,
}: {
  setup: CRMSetup | null;
  onOpenTemplates: () => void;
  onBuild: (v: BuildView) => void;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<CRMRecipesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [automate, setAutomate] = useState<{
    target: SendTarget;
    automate: Automate;
  } | null>(null);
  const [editing, setEditing] = useState<CRMRecipe | null>(null);
  const [busy, setBusy] = useState("");
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmRecipes()
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            e instanceof ApiError ? e.message : "Could not load automations.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  async function save(
    r: CRMRecipe,
    active: boolean,
    extra: Partial<CRMRecipe> = {},
  ) {
    setBusy(r.id);
    try {
      setData(
        await engageApi.saveCrmRecipe(r.id, {
          active,
          keywords: extra.keywords,
          words: extra.words,
        }),
      );
      notify(active ? `${r.title} is on.` : `${r.title} is off.`, "ok");
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not save that.",
        "error",
      );
    } finally {
      setBusy("");
    }
  }

  function toggle(r: CRMRecipe, on: boolean) {
    if (r.kind === "reminders") return onOpenTemplates();
    if (r.kind === "followup") {
      // Off is a switch; on needs a template the first time, from the send dialog.
      if (!on) return void save(r, false);
      if (r.configured && r.template) {
        return void engageApi
          .saveCrmRecipe(r.id, {
            active: true,
            template: r.template,
            language: r.language,
            params: r.params,
            delayMin: r.delayMin,
          })
          .then((d) => {
            setData(d);
            notify(`${r.title} is on.`, "ok");
          })
          .catch((e) =>
            notify(
              e instanceof ApiError ? e.message : "Could not turn that on.",
              "error",
            ),
          );
      }
      return setAutomate(automateFor(r));
    }
    if (r.kind === "keywords") {
      if (!on) return void save(r, false);
      if (!r.configured) return setEditing(r);
      return void save(r, true, { keywords: r.keywords });
    }
    return void save(r, on, { words: r.words });
  }

  if (error && !data) return <Alert tone="error">{error}</Alert>;
  if (!data)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  const followups = data.recipes.filter((r) => r.kind === "followup");
  const others = data.recipes.filter((r) => r.kind !== "followup");
  const on = data.recipes.filter((r) => r.active).length;

  return (
    <div className="grid gap-6">
      <SetupStrip setup={setup} on={on} />

      {!data.whatsappConnected && (
        <Alert tone="warn" title="WhatsApp isn't connected">
          Connect your number under Number &amp; billing to turn automations on.
        </Alert>
      )}

      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">
            After every webinar
          </h2>
          <p className="text-[12px] text-ink-3">
            By how people took part — the groups on each webinar&apos;s
            Engagement tab.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {followups.map((r) => (
            <RecipeCard
              key={r.id}
              recipe={r}
              busy={busy === r.id}
              disabled={!data.whatsappConnected}
              onToggle={(v) => toggle(r, v)}
              onEdit={() => setAutomate(automateFor(r))}
            />
          ))}
        </div>
      </section>

      <section className="grid gap-3">
        <h2 className="text-[15px] font-semibold text-ink">Always on</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {others.map((r) => (
            <RecipeCard
              key={r.id}
              recipe={r}
              busy={busy === r.id}
              disabled={!data.whatsappConnected}
              onToggle={(v) => toggle(r, v)}
              onEdit={
                r.kind === "keywords"
                  ? () => setEditing(r)
                  : r.kind === "reminders"
                    ? onOpenTemplates
                    : undefined
              }
            />
          ))}
          <Card className="flex flex-col items-start justify-center gap-2 border-dashed px-4 py-4">
            <span className="text-[13.5px] font-semibold text-ink">
              Build your own
            </span>
            <span className="text-[12px] text-ink-3">
              Step-by-step sequences, reply bots, and one-off broadcasts.
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onBuild("sequences")}
              >
                Sequences
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onBuild("bots")}
              >
                Bots
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onBuild("broadcasts")}
              >
                Broadcasts
              </Button>
            </div>
          </Card>
        </div>
      </section>

      {automate && (
        <SendDialog
          open
          target={automate.target}
          automate={automate.automate}
          onClose={() => setAutomate(null)}
          onSent={refresh}
        />
      )}
      {editing && (
        <KeywordsDialog
          recipe={editing}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            setData(d);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

export function automateFor(
  r: CRMRecipe,
  webinarId?: string,
): { target: SendTarget; automate: Automate } {
  const label = r.flow[0] ?? r.title;
  const hints = HINTS[r.group ?? ""] ?? [];
  return {
    target: webinarId
      ? {
          kind: "segment",
          webinarId,
          segment:
            followupGroups().find((g) => g.id === r.group)?.segment ?? {},
          label,
          hints,
        }
      : { kind: "recipe", label, hints },
    automate: {
      recipeId: r.id,
      delayMin: r.delayMin || 120,
      template: r.template,
      language: r.language,
      params: r.params,
    },
  };
}

function SetupStrip({ setup, on }: { setup: CRMSetup | null; on: number }) {
  const cells = [
    {
      done: Boolean(setup?.connected),
      title: setup?.connected ? "Number connected" : "Connect your number",
      sub: setup?.connected
        ? setup.displayPhone || "WhatsApp Business"
        : "Under Number & billing",
    },
    {
      done: (setup?.sendableTemplates ?? 0) > 0,
      title: `${setup?.sendableTemplates ?? 0} templates approved`,
      sub: "Meta approves each message you send first",
    },
    {
      done: on > 0,
      title:
        on > 0
          ? `${on} automation${on === 1 ? "" : "s"} on`
          : "Turn on a recipe",
      sub:
        on > 0 ? "Automations running" : "Most coaches start with the replay",
    },
  ];
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 sm:gap-px">
      {cells.map((c, i) => (
        <div key={i} className="flex items-center gap-3 bg-surface px-4 py-3">
          <span
            className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
              c.done ? "bg-ok text-white" : "bg-surface-2 text-ink-2"
            }`}
          >
            {c.done ? "✓" : i + 1}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-ink">
              {c.title}
            </span>
            <span className="block truncate text-[11.5px] text-ink-3">
              {c.sub}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function RecipeCard({
  recipe: r,
  busy,
  disabled,
  onToggle,
  onEdit,
}: {
  recipe: CRMRecipe;
  busy: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onEdit?: () => void;
}) {
  return (
    <Card
      className={`flex flex-col gap-3 px-4 py-3.5 ${r.active ? "border-ok/35" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13.5px] font-semibold text-ink">{r.title}</span>
        {busy ? (
          <Spinner className="size-4" />
        ) : (
          <Switch
            checked={r.active}
            onChange={onToggle}
            disabled={disabled && !r.active}
            label={r.title}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-2">
        {r.flow.map((f, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-3">→</span>}
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5">{f}</span>
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-3">{r.hint}</span>
        {onEdit && (r.configured || r.kind === "reminders") && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 text-[12px] font-medium text-brand hover:underline"
          >
            {r.kind === "reminders" ? "Change" : "Edit"}
          </button>
        )}
      </div>
    </Card>
  );
}

export function KeywordsDialog({
  recipe,
  onClose,
  onSaved,
}: {
  recipe: CRMRecipe;
  onClose: () => void;
  onSaved: (d: CRMRecipesResponse) => void;
}) {
  const [rows, setRows] = useState<CRMRecipeKeyword[]>(
    recipe.keywords?.length
      ? recipe.keywords
      : [
          { word: "PRICE", reply: "" },
          { word: "REPLAY", reply: "" },
        ],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    try {
      onSaved(
        await engageApi.saveCrmRecipe(recipe.id, {
          active: true,
          keywords: rows.filter((r) => r.word.trim() || r.reply.trim()),
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  const set = (i: number, patch: Partial<CRMRecipeKeyword>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Reply straight away when someone sends a word"
      description="Answers common questions any time, even when you're asleep. Words aren't case-sensitive, and these replies are free because they wrote first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner className="size-3.5" />}
            Save and turn on
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <Alert tone="error">{error}</Alert>}
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-start"
          >
            <input
              className="field"
              aria-label={`Keyword ${i + 1}`}
              placeholder="PRICE"
              value={r.word}
              onChange={(e) => set(i, { word: e.target.value })}
            />
            <textarea
              className="field min-h-16 py-2"
              aria-label={`Reply to ${r.word || `keyword ${i + 1}`}`}
              placeholder="The program is ₹4,999 for 6 weeks. Reply YES and I'll send the link."
              value={r.reply}
              onChange={(e) => set(i, { reply: e.target.value })}
            />
            <button
              type="button"
              className="h-9 text-[12px] text-ink-3 hover:text-live"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              aria-label={`Remove ${r.word || `keyword ${i + 1}`}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="justify-self-start text-[12.5px] font-medium text-brand hover:underline"
          onClick={() => setRows((prev) => [...prev, { word: "", reply: "" }])}
        >
          + Add a keyword
        </button>
      </div>
    </Modal>
  );
}
