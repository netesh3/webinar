"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, ConfirmModal, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { CRMImportMaxBytes } from "@/lib/api-types";
import type { CRMImportPreview, CRMList } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { engageApi } from "../api";
import {
  IMPORT_FIELD_OPTIONS,
  defaultListName,
  mappingProblem,
  setColumnField,
} from "../import-mapping";

/* Saved lists, and importing a CSV into one.
 *
 * Used by the broadcast composer's "A saved list" audience (mode "pick": choose a list,
 * or upload a file and use the list it makes) and by the People tab (mode "manage":
 * rename and delete). A list is permanent until deleted; deleting it keeps the
 * contacts. Most coaches upload a TagMango export, whose columns are mapped on their own.
 */

function count(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function SavedLists({
  mode,
  selectedId = "",
  onPick,
}: {
  mode: "pick" | "manage";
  selectedId?: string;
  onPick?: (list: CRMList) => void;
}) {
  const { notify } = useToast();
  const [lists, setLists] = useState<CRMList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A picked file goes straight to the preview: the button opens the system picker
   * itself, with nothing in between, and cancelling it leaves this as it was. */
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<CRMImportPreview | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const importing = upload !== null || reading !== null;

  function chooseFile() {
    fileRef.current?.click();
  }

  async function readFile(file: File) {
    setUploadError(null);
    if (file.size > CRMImportMaxBytes) {
      setUploadError("That file is over 5 MB. Split it into smaller files.");
      return;
    }
    setReading(file.name);
    try {
      setUpload(await engageApi.previewCrmImport(file));
    } catch (e: unknown) {
      setUpload(null);
      setUploadError(e instanceof ApiError ? e.message : "Could not read that file.");
    } finally {
      setReading(null);
    }
  }

  function droppedFile(e: React.DragEvent): File | null {
    const f = e.dataTransfer.files?.[0];
    return f && /\.(csv|tsv|txt)$/i.test(f.name) ? f : null;
  }
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<CRMList | null>(null);
  const [busy, setBusy] = useState(false);
  const now = new Date();

  async function load() {
    try {
      const res = await engageApi.crmLists();
      setLists(res.lists);
      setError(null);
      return res.lists;
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : "Could not load your lists.");
      setLists([]);
      return [];
    }
  }

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmLists()
      .then((res) => {
        if (!cancelled) setLists(res.lists);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Could not load your lists.");
        setLists([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function rename() {
    if (!renaming) return;
    setBusy(true);
    try {
      const updated = await engageApi.renameCrmList(renaming.id, renaming.name);
      setLists((prev) => (prev ?? []).map((l) => (l.id === updated.id ? updated : l)));
      setRenaming(null);
      notify("List renamed.", "ok");
    } catch (e: unknown) {
      notify(e instanceof ApiError ? e.message : "Could not rename that list.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await engageApi.deleteCrmList(deleting.id);
      setLists((prev) => (prev ?? []).filter((l) => l.id !== deleting.id));
      notify("List deleted. The contacts are still in your People.", "ok");
      setDeleting(null);
    } catch (e: unknown) {
      notify(e instanceof ApiError ? e.message : "Could not delete that list.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`grid gap-2 rounded-xl transition-shadow ${dragging ? "ring-2 ring-brand ring-offset-2 ring-offset-surface" : ""}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = droppedFile(e);
        if (f) void readFile(f);
        else if (e.dataTransfer.files?.length) setUploadError("Drop a .csv file (or a .tsv).");
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,.tsv,text/tab-separated-values"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void readFile(f);
        }}
      />
      {error && <Alert tone="warn">{error}</Alert>}
      {uploadError && <Alert tone="error">{uploadError}</Alert>}
      {lists === null ? (
        <p className="flex items-center gap-2 text-[12px] text-ink-3">
          <Spinner className="size-3.5" />
          Loading your lists…
        </p>
      ) : lists.length === 0 && !importing ? (
        <p className="text-[12px] leading-relaxed text-ink-3">
          No saved lists yet. Upload a CSV and it is saved as a list you can send to again.
        </p>
      ) : (
        <ul className="grid gap-1" role={mode === "pick" ? "radiogroup" : undefined} aria-label="Saved lists">
          {lists.map((l) => (
            <li
              key={l.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                mode === "pick" && l.id === selectedId ? "border-brand bg-brand-soft/40" : "border-line"
              }`}
            >
              {mode === "pick" && (
                <input
                  type="radio"
                  name="broadcast-list"
                  aria-label={l.name}
                  className="size-4 accent-brand"
                  checked={l.id === selectedId}
                  onChange={() => onPick?.(l)}
                />
              )}
              {renaming?.id === l.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename();
                  }}
                >
                  <input
                    className="field h-8 min-w-0 flex-1 text-[13px]"
                    value={renaming.name}
                    maxLength={120}
                    autoFocus
                    aria-label="List name"
                    onChange={(e) => setRenaming({ id: l.id, name: e.target.value })}
                  />
                  <Button size="sm" type="submit" disabled={busy || !renaming.name.trim()}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => mode === "pick" && onPick?.(l)}
                >
                  <span className="block truncate text-[13.5px] font-medium">{l.name}</span>
                  <span className="block text-[11.5px] text-ink-3">
                    {count(l.size, "person", "people")} · {count(l.optedIn, "opted in", "opted in")} ·
                    updated {formatRelative(l.updatedAt, now)}
                  </span>
                </button>
              )}
              {renaming?.id !== l.id && (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-1 text-[12px] text-ink-3 hover:bg-surface-2 hover:text-ink"
                    onClick={() => setRenaming({ id: l.id, name: l.name })}
                  >
                    Rename
                  </button>
                  {mode === "manage" && (
                    <button
                      type="button"
                      className="rounded-md px-1.5 py-1 text-[12px] text-live hover:bg-live-soft"
                      onClick={() => setDeleting(l)}
                    >
                      Delete
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {reading !== null ? (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] text-ink-2">
          <Spinner className="size-4 text-ink-3" />
          Reading {reading}…
        </p>
      ) : upload ? (
        <CsvImport
          key={upload.id}
          preview={upload}
          lists={lists ?? []}
          onChooseAnother={chooseFile}
          onCancel={() => setUpload(null)}
          onDone={async (list) => {
            setUpload(null);
            const fresh = await load();
            onPick?.(fresh.find((l) => l.id === list.id) ?? list);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" type="button" onClick={chooseFile}>
            Upload a CSV
          </Button>
          <span className="text-[11.5px] text-ink-3">
            or drop one here · a phone number per person, up to 10,000 rows
          </span>
        </div>
      )}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title="Delete this list?"
        body={`"${deleting?.name ?? ""}" is removed from your saved lists. The ${count(
          deleting?.size ?? 0,
          "person",
          "people",
        )} in it stay in your People, and broadcasts already sent to it are not affected.`}
        confirmLabel="Delete list"
        busy={busy}
      />
    </div>
  );
}

/* The upload: pick a file, check the column mapping against a preview, confirm consent,
 * and import into a new list or an existing one. */
function CsvImport({
  preview,
  lists,
  onChooseAnother,
  onCancel,
  onDone,
}: {
  preview: CRMImportPreview;
  lists: CRMList[];
  onChooseAnother: () => void;
  onCancel: () => void;
  onDone: (list: CRMList) => void | Promise<void>;
}) {
  const { notify } = useToast();
  const [mapping, setMapping] = useState<string[]>(preview.mapping);
  const [target, setTarget] = useState<string>("new");
  const [listName, setListName] = useState(() => defaultListName(preview.fileName, new Date()));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = mappingProblem(mapping);
  const mappingChanged = mapping.some((f, i) => f !== preview.mapping[i]);

  async function commit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await engageApi.commitCrmImport(preview.id, {
        listId: target === "new" ? undefined : target,
        listName: target === "new" ? listName.trim() : "",
        mapping,
        consentConfirmed: consent,
      });
      const parts = [
        res.created > 0 && `${count(res.created, "new contact")}`,
        res.updated > 0 && `${count(res.updated, "existing contact")} updated`,
        consent && `${count(res.optedIn, "person", "people")} opted in`,
        res.optedOut > 0 && `${count(res.optedOut, "person", "people")} had opted out and stay out`,
      ].filter(Boolean);
      notify(`Imported into "${res.list.name}": ${parts.join(", ")}.`, "ok");
      await onDone(res.list);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : "Could not import that file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-line bg-surface-2 p-3">
      {error && <Alert tone="error">{error}</Alert>}
      <>
          <div className="text-[12.5px]">
            <p className="font-medium">{preview.fileName}</p>
            <p className="text-ink-3">
              {count(preview.valid, "person", "people")} ready to import
              {preview.existing > 0 && ` (${count(preview.existing, "is", "are")} already in your contacts)`}
              {preview.duplicates > 0 && ` · ${count(preview.duplicates, "repeated row")} skipped`}
              {preview.invalidCount > 0 && ` · ${count(preview.invalidCount, "row")} left out`}
            </p>
          </div>

          <div className="grid gap-1.5">
            <span className="label">Columns</span>
            {preview.columns.map((col, i) => (
              <label key={`${col}-${i}`} className="flex items-center gap-2 text-[12.5px]">
                <span className="w-32 shrink-0 truncate text-ink-2" title={col}>
                  {col || `Column ${i + 1}`}
                </span>
                <select
                  className="field h-8 min-w-0 flex-1 text-[12.5px]"
                  value={mapping[i] ?? ""}
                  onChange={(e) => setMapping(setColumnField(mapping, i, e.target.value))}
                >
                  {IMPORT_FIELD_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {problem && <p className="text-[12px] text-live">{problem}</p>}
            {mappingChanged && !problem && (
              <p className="text-[11.5px] text-ink-3">
                The counts above are for the columns as first read; the import uses your choices.
              </p>
            )}
          </div>

          {preview.sample.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-left text-[12px]">
                <thead className="text-ink-3">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Name</th>
                    <th className="px-2 py-1.5 font-medium">Phone</th>
                    <th className="px-2 py-1.5 font-medium">Email</th>
                    <th className="px-2 py-1.5 font-medium">Service</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((p) => (
                    <tr key={p.phone} className="border-t border-line">
                      <td className="px-2 py-1.5">{p.name || "—"}</td>
                      <td className="px-2 py-1.5 tabular-nums">{p.phone}</td>
                      <td className="px-2 py-1.5">{p.email || "—"}</td>
                      <td className="px-2 py-1.5">{p.attributes?.service || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.invalid.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-ink-2">
                {count(preview.invalidCount, "row")} left out
              </summary>
              <ul className="mt-1 grid gap-0.5 text-ink-3">
                {preview.invalid.map((r) => (
                  <li key={r.row}>
                    Row {r.row}: {r.value ? `"${r.value}" — ` : ""}
                    {r.reason}
                  </li>
                ))}
                {preview.invalidCount > preview.invalid.length && (
                  <li>…and {preview.invalidCount - preview.invalid.length} more</li>
                )}
              </ul>
            </details>
          )}

          <div className="grid gap-1.5">
            <span className="label">Save as</span>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="radio"
                name="import-target"
                className="size-4 accent-brand"
                checked={target === "new"}
                onChange={() => setTarget("new")}
              />
              A new list
            </label>
            {target === "new" && (
              <input
                className="field h-9 text-[13px]"
                value={listName}
                maxLength={120}
                aria-label="New list name"
                onChange={(e) => setListName(e.target.value)}
              />
            )}
            {lists.length > 0 && (
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="radio"
                  name="import-target"
                  className="size-4 accent-brand"
                  checked={target !== "new"}
                  onChange={() => setTarget(lists[0].id)}
                />
                Add to an existing list
              </label>
            )}
            {target !== "new" && (
              <select
                className="field h-9 text-[13px]"
                value={target}
                aria-label="Existing list"
                onChange={(e) => setTarget(e.target.value)}
              >
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({count(l.size, "person", "people")})
                  </option>
                ))}
              </select>
            )}
          </div>

          <label className="flex items-start gap-2 text-[12.5px] leading-relaxed">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-brand"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I confirm these people agreed to receive WhatsApp messages from me.
              <span className="block text-[11.5px] text-ink-3">
                Without this they are saved but not messaged: WhatsApp only allows messages to
                people who opted in. Anyone who opted out stays opted out.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              disabled={busy || problem !== null || (target === "new" && !listName.trim())}
              onClick={() => void commit()}
            >
              {busy ? "Importing…" : `Import ${count(preview.valid, "person", "people")}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={onChooseAnother}
            >
              Choose another file
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
      </>
    </div>
  );
}
