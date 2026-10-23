"use client";

import { useState } from "react";
import type { AdminCostHost, CostIgnoreList, CostIgnoreRuleInput } from "@/lib/api-types";
import { Alert } from "./controls";
import { Badge, Button, Card, SectionTitle } from "./ui";

/* The Cost by host report's ignore list: test and staff accounts whose usage is not a
 * customer's. A rule is an exact email, a pattern (* is any run: *@test.dev, *+test@*) or one
 * host. The server matches rules on every report request (api/internal/api/cost_ignore.go);
 * this panel only edits the list. */

type Kind = CostIgnoreRuleInput["kind"];

const KINDS: { id: Kind; label: string; placeholder: string }[] = [
  { id: "pattern", label: "Pattern", placeholder: "*@test.dev" },
  { id: "email", label: "Email", placeholder: "qa@acme.dev" },
  { id: "host", label: "Host", placeholder: "" },
];

const KIND_LABEL: Record<string, string> = { email: "Email", pattern: "Pattern", host: "Host" };

const inputClass = "rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink";

export function CostIgnorePanel({
  list,
  hosts,
  onAdd,
  onRemove,
  onClose,
}: {
  list: CostIgnoreList | null;
  /** The report's hosts, for the host picker and each rule's count. */
  hosts: AdminCostHost[];
  onAdd: (rule: CostIgnoreRuleInput) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("pattern");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (p: Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    p.then(() => after?.())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "That did not work."))
      .finally(() => setBusy(false));
  };
  const add = (rule: CostIgnoreRuleInput, after?: () => void) => run(onAdd(rule), after);

  const pickable = hosts.filter((h) => !h.ignoredBy).sort((a, b) => a.email.localeCompare(b.email));
  const caught = (id: string) => hosts.filter((h) => h.ignoredBy === id).length;
  const placeholder = KINDS.find((k) => k.id === kind)?.placeholder ?? "";

  return (
    <Card className="grid gap-4 p-4">
      <div className="flex items-center gap-2">
        <SectionTitle>Ignore list</SectionTitle>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md px-2 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2"
        >
          Close
        </button>
      </div>
      <p className="-mt-2 text-[11.5px] text-ink-3">
        Test and staff accounts. With &quot;Hide ignored hosts&quot; on, they leave the totals and the platform share is
        spread over the other hosts only.
      </p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add({ kind, value, note }, () => {
            setValue("");
            setNote("");
          });
        }}
      >
        <select
          aria-label="Rule kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setValue("");
          }}
          className={inputClass}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        {kind === "host" ? (
          <select
            aria-label="Host"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`${inputClass} min-w-56`}
          >
            <option value="">Choose a host…</option>
            {pickable.map((h) => (
              <option key={h.hostId} value={h.hostId}>
                {h.name ? `${h.name} · ${h.email}` : h.email}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={kind === "email" ? "Email" : "Pattern"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className={`${inputClass} min-w-56`}
          />
        )}
        <input
          aria-label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          maxLength={200}
          className={`${inputClass} min-w-40 flex-1`}
        />
        <Button type="submit" size="sm" disabled={busy || !value.trim()}>
          Add
        </Button>
      </form>
      {kind === "pattern" && (
        <p className="-mt-2 text-[11.5px] text-ink-3">* matches anything: *@test.dev, *@example.com, *+test@*.</p>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      {list === null ? (
        <p className="text-[12.5px] text-ink-3">Loading…</p>
      ) : list.rules.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">Nothing ignored yet.</p>
      ) : (
        <table className="w-full text-left text-[12.5px]">
          <tbody>
            {list.rules.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 whitespace-nowrap">
                  <Badge>{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                </td>
                <td className="py-2 pr-3">
                  <div className="font-medium text-ink">{r.label}</div>
                  {r.note && <div className="text-[11.5px] text-ink-3">{r.note}</div>}
                </td>
                <td className="py-2 pr-3 text-[11.5px] whitespace-nowrap text-ink-3">
                  {caught(r.id)} {caught(r.id) === 1 ? "host" : "hosts"} in this range
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(onRemove(r.id))}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {list && list.suggestions.length > 0 && (
        <div className="grid gap-2">
          <div className="text-[11.5px] font-medium text-ink-3">Suggestions</div>
          <ul className="grid gap-1">
            {list.suggestions.map((s) => (
              <li key={`${s.kind}:${s.value}`} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <Badge>{KIND_LABEL[s.kind] ?? s.kind}</Badge>
                <span className="text-ink">{s.label}</span>
                <span className="text-[11.5px] text-ink-3">
                  {s.reason}
                  {s.kind === "pattern" && ` · ${s.matches} ${s.matches === 1 ? "account" : "accounts"}`}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => add({ kind: s.kind, value: s.value, note: s.reason })}
                  className="ml-auto rounded-md border border-line px-2 py-0.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                >
                  Ignore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
