"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { ApiError, del, fresh, post, put, request } from "@/lib/http";
import { Alert } from "../controls";

type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  key?: string;
  customized?: boolean;
  updatedAt: string;
};

type Draft = {
  id: string | null;
  name: string;
  subject: string;
  body: string;
  key: string;
  customized: boolean;
};

const blank = (): Draft => ({
  id: null,
  name: "",
  subject: "",
  body: "",
  key: "",
  customized: false,
});

function updatedLabel(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EmailTemplates({ onCount }: { onCount?: (count: number) => void }) {
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);

  useEffect(() => {
    let gone = false;
    request<{ templates: EmailTemplate[] }>("/api/host/email-templates", fresh)
      .then((res) => {
        if (gone) return;
        const rows = res.templates ?? [];
        setTemplates(rows);
        setError(null);
        onCount?.(rows.length);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Could not load templates.");
      });
    return () => {
      gone = true;
    };
  }, [onCount]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = templates ?? [];
    if (!q) return rows;
    return rows.filter((template) =>
      `${template.name} ${template.subject} ${template.body}`.toLowerCase().includes(q),
    );
  }, [templates, query]);

  function open(template: EmailTemplate) {
    setError(null);
    setConfirmRevert(false);
    setDraft({
      id: template.id,
      name: template.name,
      subject: template.subject,
      body: template.body,
      key: template.key ?? "",
      customized: Boolean(template.customized),
    });
  }

  function remember(saved: EmailTemplate) {
    setTemplates((cur) => {
      const rest = (cur ?? []).filter((template) => template.id !== saved.id);
      const next = [saved, ...rest];
      onCount?.(next.length);
      return next;
    });
    setDraft({
      id: saved.id,
      name: saved.name,
      subject: saved.subject,
      body: saved.body,
      key: saved.key ?? "",
      customized: Boolean(saved.customized),
    });
  }

  async function save() {
    if (!draft) return;
    const payload = {
      name: draft.name.trim(),
      subject: draft.subject.trim(),
      body: draft.body.trim(),
    };
    if (!payload.name || !payload.subject || !payload.body) return;
    setSaving(true);
    setError(null);
    try {
      const saved = draft.id
        ? await put<EmailTemplate>(`/api/host/email-templates/${draft.id}`, payload)
        : await post<EmailTemplate>("/api/host/email-templates", payload);
      remember(saved);
      setConfirmRevert(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that template.");
    } finally {
      setSaving(false);
    }
  }

  async function revert() {
    if (!draft?.id) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await post<EmailTemplate>(`/api/host/email-templates/${draft.id}/revert`);
      remember(saved);
      setConfirmRevert(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revert that template.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft?.id || draft.key) return;
    setSaving(true);
    setError(null);
    try {
      await del(`/api/host/email-templates/${draft.id}`);
      setTemplates((cur) => {
        const next = (cur ?? []).filter((template) => template.id !== draft.id);
        onCount?.(next.length);
        return next;
      });
      setDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete that template.");
    } finally {
      setSaving(false);
    }
  }

  const ready = Boolean(draft?.name.trim() && draft.subject.trim() && draft.body.trim());
  const tokens = [...new Set(draft?.body.match(/\{\{[a-z_]+\}\}/g) ?? [])];

  return (
    <div className="grid gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search templates</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            className="field h-9 w-full pl-8 text-[13px]"
          />
        </label>
        <Button
          type="button"
          onClick={() => {
            setError(null);
            setConfirmRevert(false);
            setDraft(blank());
          }}
        >
          New template
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.9fr)]">
        <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-ink-3">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Subject</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {templates === null ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[13px] text-ink-3">
                      Loading…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[13px] text-ink-3">
                      {query.trim() ? "No templates match that." : "No templates yet."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((template) => {
                    const on = draft?.id === template.id;
                    return (
                      <tr
                        key={template.id}
                        className={`cursor-pointer border-b border-line last:border-b-0 ${
                          on ? "bg-brand-soft" : "hover:bg-surface-2"
                        }`}
                        onClick={() => open(template)}
                      >
                        <td className="px-4 py-2.5 font-semibold text-ink">{template.name}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2.5 text-ink-2">
                          {template.subject}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-[12px] text-ink-3">
                          {template.key
                            ? template.customized
                              ? "Changed"
                              : "Default"
                            : ""}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-ink-3">
                          {updatedLabel(template.updatedAt)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <form
          className="grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!draft ? (
            <p className="py-8 text-center text-[13px] text-ink-3">Select a template.</p>
          ) : (
            <>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">
                {draft.id ? "Edit template" : "New template"}
              </h2>
              <label className="grid gap-1 text-[12px] font-medium text-ink-2">
                Name
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  disabled={Boolean(draft.key)}
                  className="field text-[13.5px] disabled:bg-surface-2"
                  maxLength={80}
                />
              </label>
              <label className="grid gap-1 text-[12px] font-medium text-ink-2">
                Subject
                <input
                  value={draft.subject}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                  className="field text-[13.5px]"
                  maxLength={200}
                />
              </label>
              <label className="grid gap-1 text-[12px] font-medium text-ink-2">
                Body
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={8}
                  className="field text-[13.5px]"
                  maxLength={8000}
                />
              </label>
              {tokens.length > 0 && (
                <p className="text-[12px] text-ink-3">{tokens.join(" ")}</p>
              )}
              {confirmRevert ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="mr-auto text-[12.5px] text-ink-2">Put the original wording back?</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => setConfirmRevert(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="button" size="sm" disabled={saving} onClick={() => void revert()}>
                    Revert
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  {draft.id && !draft.key && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={saving}
                      onClick={() => void remove()}
                    >
                      Delete
                    </Button>
                  )}
                  {draft.key && draft.customized && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={saving}
                      onClick={() => setConfirmRevert(true)}
                    >
                      Revert
                    </Button>
                  )}
                  <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={saving || !ready}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              )}
            </>
          )}
        </form>
      </div>
    </div>
  );
}
