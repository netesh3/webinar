"use client";

import { useEffect, useMemo, useState } from "react";
import { engageApi } from "../api";
import { SearchIcon } from "@/components/icons";
import { useSession } from "@/components/providers";
import { SortHeader, useSort } from "@/components/sort-header";
import { Button, ListPager } from "@/components/ui";
import type { CRMTemplate, MessageSlot } from "@/lib/api-types";
import { sortBy } from "@/lib/table-sort";
import { MESSAGE_ROWS } from "./messages/catalog";
import { templateKey } from "./crm-templates";
import { CategoryPill, PhoneFrame, friendlyTemplateName } from "./wa-kit";
import { WriteWordingDialog } from "./write-wording-dialog";

/* Templates tab: search and New template on one row, then the list and the
 * phone preview. New template opens the existing wording dialog. */

const PAGE = 8;

type TemplateSort = "name" | "category" | "language" | "status" | "used";

function statusLabel(template: CRMTemplate): string {
  const status = template.status.toUpperCase();
  if (status === "APPROVED" || template.sendable) return "Approved";
  if (status === "REJECTED") return "Rejected";
  if (status === "PENDING") return "Pending";
  return status
    ? status.charAt(0) + status.slice(1).toLowerCase()
    : "Pending";
}

function usedIn(template: CRMTemplate, slots: MessageSlot[]): string {
  const titles = slots
    .filter(
      (slot) =>
        slot.template === template.name && slot.language === template.language,
    )
    .map(
      (slot) => MESSAGE_ROWS.find((row) => row.kind === slot.kind)?.title ?? slot.kind,
    );
  return titles.length ? titles.join(", ") : "";
}

export function WhatsAppTemplates({
  templates,
  onCreated,
}: {
  templates: CRMTemplate[] | null;
  onCreated: () => void;
}) {
  const { account } = useSession();
  const connected = Boolean(account?.whatsapp?.connected);
  const coach = account?.whatsapp?.verifiedName || account?.name || "You";
  const [slots, setSlots] = useState<MessageSlot[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    engageApi
      .messageDefaults()
      .then((res) => {
        if (!cancelled) setSlots(res.slots ?? []);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { sort, onSort } = useSort<TemplateSort>({
    defaultDir: {
      name: "asc",
      category: "asc",
      language: "asc",
      status: "asc",
      used: "asc",
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = templates ?? [];
    const matched = q
      ? list.filter((template) => {
          const hay = `${template.name} ${friendlyTemplateName(template.name)} ${template.body ?? ""}`.toLowerCase();
          return hay.includes(q);
        })
      : list;
    if (!sort.key) return matched;
    const value = (template: CRMTemplate) => {
      if (sort.key === "name") return friendlyTemplateName(template.name);
      if (sort.key === "category") return template.category;
      if (sort.key === "language") return template.language;
      if (sort.key === "status") return statusLabel(template);
      return usedIn(template, slots);
    };
    return sortBy(matched, sort.dir, value, "string");
  }, [templates, query, sort, slots]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const rows = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const selected =
    filtered.find((template) => templateKey(template) === picked) ?? rows[0] ?? null;
  const start = filtered.length === 0 ? 0 : safePage * PAGE + 1;
  const end = Math.min(filtered.length, safePage * PAGE + rows.length);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search templates</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search templates"
            className="field h-9 w-full pl-8 text-[13px]"
          />
        </label>
        <Button type="button" onClick={() => setWriting(true)}>
          New template
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.7fr)]">
        <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-ink-3">
                  {(
                    [
                      ["name", "Name"],
                      ["category", "Category"],
                      ["language", "Language"],
                      ["status", "Status"],
                      ["used", "Used in"],
                    ] as const
                  ).map(([key, label]) => (
                    <SortHeader
                      key={key}
                      label={label}
                      active={sort.key === key}
                      dir={sort.dir}
                      hintDir="asc"
                      onSort={() => onSort(key)}
                      className="px-3 py-2.5 font-medium first:pl-4"
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {templates === null ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[13px] text-ink-3">
                      Loading templates…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[13px] text-ink-3">
                      {query.trim()
                        ? "No templates match that."
                        : "No templates yet."}
                    </td>
                  </tr>
                ) : (
                  rows.map((template) => {
                    const key = templateKey(template);
                    const on = selected ? templateKey(selected) === key : false;
                    const where = usedIn(template, slots);
                    return (
                      <tr
                        key={key}
                        className={`cursor-pointer border-b border-line last:border-b-0 ${
                          on ? "bg-brand-soft" : "hover:bg-surface-2"
                        }`}
                        onClick={() => setPicked(key)}
                      >
                        <td className="px-4 py-2.5">
                          <b className="block font-semibold text-ink">
                            {friendlyTemplateName(template.name)}
                          </b>
                          <span className="text-[11.5px] text-ink-3">{template.name}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <CategoryPill category={template.category} />
                        </td>
                        <td className="px-3 py-2.5 text-ink-2">{template.language}</td>
                        <td className="px-3 py-2.5">
                          <StatusText template={template} />
                        </td>
                        <td className="px-3 py-2.5 text-ink-2">{where || "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <ListPager
            layout="split"
            range="stack"
            className="border-t border-line px-4 py-2.5"
            page={safePage + 1}
            pages={pages}
            pageSize={PAGE}
            start={start}
            end={end}
            total={filtered.length}
            onPrevious={() => setPage((n) => Math.max(0, Math.min(n, pages - 1) - 1))}
            onNext={() => setPage((n) => Math.min(pages - 1, n + 1))}
          />
        </section>

        <aside className="grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
          {selected ? (
            <>
              <div>
                <h2 className="text-[14px] font-semibold">
                  {friendlyTemplateName(selected.name)}
                </h2>
                <p className="mt-0.5 text-[12px] text-ink-2">
                  {selected.category} · {selected.language} · {statusLabel(selected)}
                </p>
              </div>
              <PhoneFrame title={coach} subtitle="Business account">
                <div className="max-w-[92%] overflow-hidden rounded-lg rounded-tl-none bg-white text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#111] shadow-sm">
                  <div className="px-2.5 py-1.5">
                    {selected.header && <p className="font-semibold">{selected.header}</p>}
                    {selected.body || "This template has no message text."}
                    {(selected.buttons ?? []).length > 0 && (
                      <div className="mt-1.5 flex flex-col border-t border-black/5 pt-1">
                        {selected.buttons.map((button) => (
                          <span
                            key={button.text}
                            className="inline-flex items-center justify-center py-1 text-[12px] font-medium text-[#027eb5]"
                          >
                            {button.text}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </PhoneFrame>
              <p className="text-[12px] text-ink-3">
                {usedIn(selected, slots)
                  ? `Used in ${usedIn(selected, slots)}`
                  : "Not used on a message yet."}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-ink-3">No template to preview.</p>
          )}
        </aside>
      </div>

      {writing && (
        <WriteWordingDialog
          connected={connected}
          onClose={() => setWriting(false)}
          onCreated={() => {
            onCreated();
          }}
          onUse={async () => {
            onCreated();
            setWriting(false);
            return true;
          }}
        />
      )}
    </div>
  );
}

function StatusText({ template }: { template: CRMTemplate }) {
  const label = statusLabel(template);
  const tone =
    label === "Approved"
      ? "text-ok"
      : label === "Rejected"
        ? "text-live"
        : "text-warn";
  return (
    <span className={`font-medium ${tone}`}>
      {label}
      {label === "Rejected" && template.unsupported && (
        <span className="mt-0.5 block text-[11px] font-normal text-ink-3">
          {template.unsupported}
        </span>
      )}
    </span>
  );
}
