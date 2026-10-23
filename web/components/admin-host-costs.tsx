"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  AdminCostHostDetail,
  AdminCostsResponse,
  CostIgnoreList,
  CostIgnoreRule,
  CostIgnoreRuleInput,
} from "@/lib/api-types";
import type { CostInputs } from "@/lib/cost-calculator";
import {
  COLUMN_LABELS,
  COST_COLUMNS,
  costContext,
  hostContext,
  hostsCsv,
  presetRange,
  priceHost,
  priceReport,
  priceSession,
  sessionsCsv,
  visibleHosts,
  type CostContext,
  type HostCostLine,
  type PricedHost,
  type RangePreset,
} from "@/lib/host-costs";
import { loadInputs } from "./admin-cost-calculator";
import { CostIgnorePanel } from "./admin-cost-ignore";
import { Alert, Toggle } from "./controls";
import { DateRangeField } from "./date-picker";
import { Badge, Card, SectionTitle, Stat } from "./ui";

/* Cost by host: what each host's recorded usage would have cost us, priced at the Cost
 * calculator's rates (this browser's, the same inputs that tab saves). Estimates, not
 * invoices: the API returns hours, GB and counts (GET /api/admin/costs) and
 * lib/host-costs.ts prices them; only AI is the recorded cost of each call. */

const PRESETS: { id: Exclude<RangePreset, "custom">; label: string }[] = [
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "all", label: "All time" },
];
const PROVIDER_FILTERS = [
  { id: "", label: "All providers" },
  { id: "gcp", label: "GCP" },
  { id: "hetzner", label: "Hetzner" },
  { id: "do", label: "DigitalOcean" },
];

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function money(inputs: CostInputs) {
  const rate = inputs.inrPerUsd > 0 ? inputs.inrPerUsd : 100;
  return {
    inr: (usd: number) => `₹${(usd * rate).toLocaleString("en-IN", { maximumFractionDigits: usd * rate < 100 ? 2 : 0 })}`,
    usd: (n: number) => `$${n.toFixed(n < 10 ? 3 : 2)}`,
  };
}

export function AdminHostCosts() {
  const [inputs] = useState<CostInputs>(loadInputs);
  const [preset, setPreset] = useState<RangePreset>("month");
  const [range, setRange] = useState(() => presetRange("month", new Date()));
  const [provider, setProvider] = useState("");
  const [allocate, setAllocate] = useState(true);
  const [hideIgnored, setHideIgnored] = useState(true);
  const [report, setReport] = useState<AdminCostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [ignoreList, setIgnoreList] = useState<CostIgnoreList | null>(null);
  const [ignoreOpen, setIgnoreOpen] = useState(false);

  const load = useCallback(
    (fresh = false) => {
      api
        .adminCosts({ ...range, provider, fresh })
        .then((next) => {
          setReport(next);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load costs."));
    },
    [range, provider],
  );
  useEffect(() => load(), [load]);

  const loadIgnores = useCallback(() => {
    api
      .costIgnoreList()
      .then(setIgnoreList)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the ignore list."));
  }, []);
  useEffect(() => loadIgnores(), [loadIgnores]);
  // The server matches the list on every report request, so a reload (cached usage) is enough.
  const afterIgnoreChange = () => {
    loadIgnores();
    load();
  };
  const addIgnore = (rule: CostIgnoreRuleInput) => api.addCostIgnoreRule(rule).then(afterIgnoreChange);
  const removeIgnore = (id: string) => api.deleteCostIgnoreRule(id).then(afterIgnoreChange);
  const rules = useMemo(
    () => new Map<string, CostIgnoreRule>((ignoreList?.rules ?? []).map((r) => [r.id, r])),
    [ignoreList],
  );

  const ctx = useMemo(
    () =>
      report ? costContext(report.platform, report.rangeStart, report.rangeEnd, inputs, allocate, hideIgnored) : null,
    [report, inputs, allocate, hideIgnored],
  );
  const priced = useMemo(() => (report && ctx ? priceReport(report.hosts, ctx) : null), [report, ctx]);
  const visible = priced ? visibleHosts(priced, hideIgnored) : [];
  const m = money(inputs);

  if (hostId && ctx) {
    return (
      <HostDetail
        id={hostId}
        range={range}
        provider={provider}
        inputs={inputs}
        allocate={allocate}
        hideIgnored={hideIgnored}
        onBack={() => setHostId(null)}
      />
    );
  }

  const row = (p: PricedHost) => {
    const rule = p.host.ignoredBy ? rules.get(p.host.ignoredBy) : undefined;
    return (
      <tr
        key={p.host.hostId}
        className={`cursor-pointer border-b border-line last:border-0 hover:bg-surface-2 ${p.host.ignoredBy ? "opacity-60" : ""}`}
        onClick={() => setHostId(p.host.hostId)}
      >
        <td className="px-3 py-2">
          <button type="button" className="text-left font-medium text-ink hover:underline">
            {p.host.name || p.host.email}
          </button>
          <div className="text-[11.5px] text-ink-3">{p.host.email}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          <div className="font-semibold text-ink">{m.inr(p.totalUsd)}</div>
          <div className="text-[11.5px] text-ink-3">{m.usd(p.totalUsd)}</div>
        </td>
        {COST_COLUMNS.map((c) => (
          <td key={c} className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-ink-2">
            {p.columns[c] > 0 ? m.inr(p.columns[c]) : "—"}
          </td>
        ))}
        <td className="px-3 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          {!p.host.ignoredBy ? (
            <button
              type="button"
              title="Add this host to the ignore list"
              onClick={() => addIgnore({ kind: "host", value: p.host.hostId, note: "Ignored from the report" }).catch(
                (e: unknown) => setError(e instanceof Error ? e.message : "Could not ignore this host."),
              )}
              className="rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              Ignore
            </button>
          ) : rule && rule.kind !== "pattern" ? (
            <button
              type="button"
              onClick={() => removeIgnore(rule.id).catch(
                (e: unknown) => setError(e instanceof Error ? e.message : "Could not stop ignoring this host."),
              )}
              className="rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
            >
              Stop ignoring
            </button>
          ) : (
            <span className="text-[11.5px] text-ink-3">{rule ? `matches ${rule.label}` : "ignored"}</span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="grid gap-4">
      <Card className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => {
                setPreset(p.id);
                setRange(presetRange(p.id, new Date()));
              }}
              className={`rounded-md px-2.5 py-1 text-[12.5px] ${
                preset === p.id ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              {p.label}
            </button>
          ))}
          <DateRangeField
            size="sm"
            from={range.from}
            to={range.to}
            emptyLabel="All time"
            ariaLabel="Custom range"
            onChange={(from, to) => {
              setPreset(from || to ? "custom" : "all");
              setRange({ from, to });
            }}
          />
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink"
          >
            {PROVIDER_FILTERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => load(true)}
            className="rounded-md px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2"
          >
            Refresh
          </button>
          <button
            type="button"
            aria-expanded={ignoreOpen}
            onClick={() => setIgnoreOpen((o) => !o)}
            className="ml-auto rounded-md px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2"
          >
            Ignore list{ignoreList && ignoreList.rules.length > 0 ? ` (${ignoreList.rules.length})` : ""}
          </button>
          <button
            type="button"
            disabled={visible.length === 0}
            onClick={() =>
              download(
                `host-costs-${range.from || "all"}-${range.to || "now"}${hideIgnored ? "" : "-with-ignored"}.csv`,
                hostsCsv(visible, inputs.inrPerUsd),
              )
            }
            className="rounded-md border border-line px-2.5 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
        <Toggle
          checked={allocate}
          onChange={setAllocate}
          label="Spread platform costs over hosts"
          description="Supabase, Workers, the API host, video servers' idle hours and spend with no host, shared by session-hours. Off shows them as one unallocated figure."
        />
        <Toggle
          checked={hideIgnored}
          onChange={setHideIgnored}
          label="Hide ignored hosts"
          description={
            <>
              {priced && priced.ignored.length > 0
                ? `${priced.ignored.length} ${priced.ignored.length === 1 ? "host" : "hosts"} ignored (${m.inr(priced.ignoredUsd)}). `
                : "No host in this range is on the ignore list. "}
              On, they leave the totals and the CSV, and the platform share is spread over the other hosts. Off, they
              are counted again and listed apart.
            </>
          }
        />
        <p className="text-[11.5px] text-ink-3">
          Estimated from recorded usage at the Cost calculator&apos;s rates ({inputs.providers[inputs.provider].label} for the
          API host; ₹{inputs.inrPerUsd} = $1). Not invoices; only AI is the recorded cost.
          {provider && " With a provider chosen, AI, email and storage are left out: they belong to no video server."}
        </p>
      </Card>

      {ignoreOpen && (
        <CostIgnorePanel
          list={ignoreList}
          hosts={report?.hosts ?? []}
          onAdd={addIgnore}
          onRemove={removeIgnore}
          onClose={() => setIgnoreOpen(false)}
        />
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {!report && !error && <p className="py-6 text-center text-[13px] text-ink-2">Loading…</p>}

      {report && ctx && priced && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Hosts' estimated cost" value={m.inr(priced.totalUsd)} note={m.usd(priced.totalUsd)} />
            <Stat
              label={allocate ? "Platform cost (spread)" : "Unallocated platform cost"}
              value={m.inr(ctx.platform.usd)}
              note={`${m.usd(ctx.platform.perSessionHourUsd)} per session-hour`}
            />
            <Stat
              label="Hosts with usage"
              value={String(hideIgnored ? priced.counted.length : visible.length)}
              note={
                priced.ignored.length > 0
                  ? `${priced.ignored.length} ignored (${m.inr(priced.ignoredUsd)})${hideIgnored ? ", hidden" : ""}`
                  : undefined
              }
            />
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="border-b border-line bg-surface-2 text-[11.5px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-medium">Host</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  {COST_COLUMNS.map((c) => (
                    <th key={c} className="px-3 py-2 text-right font-medium">
                      {COLUMN_LABELS[c]}
                    </th>
                  ))}
                  <th className="px-3 py-2">
                    <span className="sr-only">Ignore</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {priced.counted.map(row)}
                {priced.counted.length === 0 && (
                  <tr>
                    <td colSpan={COST_COLUMNS.length + 3} className="px-3 py-6 text-center text-ink-3">
                      {priced.ignored.length > 0 ? "Only ignored hosts have usage in this range." : "No usage in this range."}
                    </td>
                  </tr>
                )}
              </tbody>
              {!hideIgnored && priced.ignored.length > 0 && (
                <tbody>
                  <tr className="border-y border-line bg-surface-2">
                    <td colSpan={COST_COLUMNS.length + 3} className="px-3 py-1.5 text-[11.5px] font-medium text-ink-3">
                      Ignored ({priced.ignored.length}) · counted in the totals while &quot;Hide ignored hosts&quot; is off
                    </td>
                  </tr>
                  {priced.ignored.map(row)}
                </tbody>
              )}
            </table>
          </Card>
          {ctx.platform.lines.length > 0 && (
            <Card className="p-4">
              <SectionTitle>
                {!allocate
                  ? "Unallocated platform cost"
                  : hideIgnored && priced.ignored.length > 0
                    ? "Platform cost, spread by session-hours of hosts not ignored"
                    : "Platform cost, spread by session-hours"}
              </SectionTitle>
              <Lines lines={ctx.platform.lines} inputs={inputs} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Lines({ lines, inputs }: { lines: HostCostLine[]; inputs: CostInputs }) {
  const m = money(inputs);
  return (
    <table className="w-full text-left text-[12.5px]">
      <tbody>
        {lines.map((l) => (
          <tr key={`${l.column}-${l.key}-${l.label}`} className="border-b border-line last:border-0">
            <td className="py-2 pr-3">
              <div className={`font-medium ${l.info ? "text-ink-2" : "text-ink"}`}>
                {l.label} <span className="text-[11px] font-normal text-ink-3">· {COLUMN_LABELS[l.column]}</span>
              </div>
              <div className="text-[11.5px] text-ink-3">{l.note}</div>
            </td>
            <td className="py-2 text-right tabular-nums whitespace-nowrap">
              {l.info ? (
                <span className="text-ink-3">$0 to us</span>
              ) : (
                <>
                  {m.inr(l.usd)}
                  <div className="text-[11.5px] text-ink-3">{m.usd(l.usd)}</div>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HostDetail({
  id,
  range,
  provider,
  inputs,
  allocate,
  hideIgnored,
  onBack,
}: {
  id: string;
  range: { from: string; to: string };
  provider: string;
  inputs: CostInputs;
  allocate: boolean;
  hideIgnored: boolean;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<AdminCostHostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .adminCostHost(id, { ...range, provider })
      .then((next) => {
        setDetail(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load this host."));
  }, [id, range, provider]);

  // An ignored host, hidden, takes no platform share: its sessions are priced the same way.
  const ctx: CostContext | null = useMemo(
    () =>
      detail
        ? hostContext(
            costContext(detail.platform, detail.rangeStart, detail.rangeEnd, inputs, allocate, hideIgnored),
            detail.host,
          )
        : null,
    [detail, inputs, allocate, hideIgnored],
  );
  const m = money(inputs);
  const priced = detail && ctx ? priceHost(detail.host, ctx) : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-md px-2 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2">
          ← All hosts
        </button>
        {detail && (
          <h2 className="text-[14px] font-semibold text-ink">
            {detail.host.name || detail.host.email}{" "}
            <span className="text-[12px] font-normal text-ink-3">{detail.host.email}</span>
          </h2>
        )}
        {detail?.host.ignoredBy && (
          <Badge tone="warn">{hideIgnored ? "Ignored: left out of the report" : "On the ignore list"}</Badge>
        )}
        {detail && ctx && (
          <button
            type="button"
            onClick={() => download(`host-sessions-${detail.host.email}.csv`, sessionsCsv(detail.sessions, ctx))}
            className="ml-auto rounded-md border border-line px-2.5 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2"
          >
            Export sessions CSV
          </button>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!detail && !error && <p className="py-6 text-center text-[13px] text-ink-2">Loading…</p>}
      {detail && ctx && priced && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Estimated cost" value={m.inr(priced.totalUsd)} note={m.usd(priced.totalUsd)} />
            <Stat label="Sessions" value={String(detail.sessions.length)} />
            <Stat label="Session-hours" value={priced.sessionHours.toFixed(1)} />
            <Stat
              label="Biggest part"
              value={
                COLUMN_LABELS[
                  COST_COLUMNS.reduce((a, c) => (priced.columns[c] > priced.columns[a] ? c : a), COST_COLUMNS[0])
                ]
              }
            />
          </div>
          <Card className="p-4">
            <SectionTitle>Where the cost comes from</SectionTitle>
            {priced.lines.length ? (
              <Lines lines={priced.lines} inputs={inputs} />
            ) : (
              <p className="text-[12.5px] text-ink-3">No usage in this range.</p>
            )}
          </Card>
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="border-b border-line bg-surface-2 text-[11.5px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Session</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 text-right font-medium">Attendees</th>
                  <th className="px-3 py-2 text-right font-medium">Minutes</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  {(["delivery", "meetings", "video", "recording", "platform"] as const).map((c) => (
                    <th key={c} className="px-3 py-2 text-right font-medium">
                      {COLUMN_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.sessions.map((s) => {
                  const p = priceSession(s, ctx);
                  return (
                    <tr key={s.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap text-ink-2">
                        {new Date(s.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{s.topic}</div>
                        <div className="text-[11.5px] text-ink-3">
                          {s.provider === "none" ? "no video server" : `${s.provider} · ${s.project}`}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-ink-2">
                        {s.kind}
                        {s.delivery === "edge" ? " · edge" : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.usage.attendees}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round(s.usage.sessionHours * 60)}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium">{m.inr(p.totalUsd)}</td>
                      {(["delivery", "meetings", "video", "recording", "platform"] as const).map((c) => (
                        <td key={c} className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-ink-2">
                          {p.columns[c] > 0 ? m.inr(p.columns[c]) : "—"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {detail.sessions.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-ink-3">
                      No sessions in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <p className="text-[11.5px] text-ink-3">
            Session rows hold what each session used; AI, email and storage are the host&apos;s and sit in the lines above.
          </p>
        </>
      )}
    </div>
  );
}
