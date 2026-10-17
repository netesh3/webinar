"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { engageApi } from "../api";
import { Modal, Spinner } from "@/components/controls";
import { MaterialIcon } from "@/components/icons";
import { useAppConfig, useSession, useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { FeatureWhatsAppCRM, type CRMMediaDeleteResult, type CRMMediaFile, type CRMMediaSkipped } from "@/lib/api-types";
import { MEDIA_RULES, headerFileProblem, type MediaFormat } from "../header-media";
import {
  acceptedKinds,
  deleteSummary,
  formatForUpload,
  galleryTabs,
  listType,
  mergePage,
  pickProblem,
  spaceProblem,
  spaceSize,
  spaceSummary,
  uploadedText,
  usageText,
  type CardAspect,
  type GalleryTab,
  type Space,
} from "../media-gallery";
import { isHeic, processedSummary, sizeText } from "../template-options";
import { prepareImage } from "./image-upload";

/* The media library, as a picker: every file the host uploaded for templates, to
 * choose one again instead of uploading it again — or upload a new one, which is then
 * chosen. Used by every header and card file button (HeaderFileButton) and by the
 * webinar cover picker. Rules (tabs, shapes, space) are in ../media-gallery.ts.
 *
 * Deleting is here too, one file or several: a file still used by a template or a
 * broadcast that has not gone out is kept, and the gallery says where it is used. */

const PAGE = 24;

/** Whether this account has a media library to pick from: the deployment runs the
 *  CRM and the account has it switched on. Without it a picker uploads directly. */
export function useMediaLibrary(): boolean {
  const { whatsappConnect } = useAppConfig();
  const { account } = useSession();
  return Boolean(whatsappConnect) && (account?.features ?? []).includes(FeatureWhatsAppCRM);
}

/** The gallery as the webinar cover picker sees it: images only. The cover is a copy
 *  made on save (POST /webinars/{slug}/image/from-media). */
export function CoverGallery({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (file: CRMMediaFile) => void;
}) {
  return (
    <MediaGallery open={open} onClose={onClose} accept={COVER_ACCEPT}
      title="Choose a cover image"
      description="An image from your media library, copied into this webinar's cover when you save. 16:9 looks best."
      onSelect={onSelect}
    />
  );
}

const COVER_ACCEPT: MediaFormat[] = ["IMAGE"];

export function MediaGallery({
  open,
  onClose,
  accept,
  aspect,
  title,
  description,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  /** The formats the caller takes; tabs and uploads follow. */
  accept: MediaFormat[];
  /** A carousel card's shape: other images are shown but cannot be picked, and an
   *  upload is center-cropped to it. */
  aspect?: CardAspect;
  title?: string;
  description?: string;
  /** The chosen file — picked from the grid, or just uploaded. The gallery closes. */
  onSelect: (file: CRMMediaFile) => void | Promise<void>;
}) {
  // Escape closes this dialog only, not the editor it was opened from.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return <GalleryBody onClose={onClose} accept={accept} aspect={aspect} title={title} description={description} onSelect={onSelect} />;
}

function GalleryBody({
  onClose,
  accept,
  aspect,
  title,
  description,
  onSelect,
}: {
  onClose: () => void;
  accept: MediaFormat[];
  aspect?: CardAspect;
  title?: string;
  description?: string;
  onSelect: (file: CRMMediaFile) => void | Promise<void>;
}) {
  const { notify } = useToast();
  const searchId = useId();
  // Keyed by value: callers pass a fresh array each render, which must not refetch.
  const acceptKey = accept.join(",");
  const tabs = useMemo(() => galleryTabs(acceptKey.split(",") as MediaFormat[]), [acceptKey]);
  const kinds = useMemo(() => acceptedKinds(acceptKey.split(",") as MediaFormat[]), [acceptKey]);
  const [tab, setTab] = useState<GalleryTab["id"]>(tabs[0]?.id ?? "all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [files, setFiles] = useState<CRMMediaFile[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [space, setSpace] = useState<Space | null>(null);
  // Which query the grid shows; it is loading while that is not the one asked for.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState<CRMMediaDeleteResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  // Typing settles before the library is asked.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const queryKey = `${tab}|${search}|${reloads}`;
  const loading = loadedKey !== queryKey || loadingMore;

  const fetchPage = useCallback(
    async (after?: string) => {
      const page = await engageApi.listCrmMedia({ type: listType(tab), q: search, cursor: after, limit: PAGE });
      // "All" lists every kind; only the ones this caller takes are shown.
      return { page, shown: page.files.filter((f) => kinds.includes(f.kind as never)) };
    },
    [tab, search, kinds],
  );

  // The first page of whatever is asked for. State is set only when it answers.
  useEffect(() => {
    const ticket = ++latest.current;
    fetchPage().then(
      ({ page, shown }) => {
        if (ticket !== latest.current) return;
        setFiles(shown);
        setCursor(page.nextCursor || undefined);
        setSpace({ usedBytes: page.usedBytes, limitBytes: page.limitBytes });
        setLoadError(null);
        setLoadedKey(queryKey);
      },
      (e) => {
        if (ticket !== latest.current) return;
        setLoadError(e instanceof ApiError ? e.message : "Could not load your media.");
        setLoadedKey(queryKey);
      },
    );
  }, [fetchPage, queryKey]);

  async function loadMore(after: string) {
    const ticket = ++latest.current;
    setLoadingMore(true);
    try {
      const { page, shown } = await fetchPage(after);
      if (ticket !== latest.current) return;
      setFiles((prev) => mergePage(prev, shown));
      setCursor(page.nextCursor || undefined);
      setSpace({ usedBytes: page.usedBytes, limitBytes: page.limitBytes });
    } catch (e) {
      if (ticket === latest.current) setLoadError(e instanceof ApiError ? e.message : "Could not load your media.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function choose(file: CRMMediaFile) {
    setChoosing(file.id);
    try {
      await onSelect(file);
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not use that file.", "error");
    } finally {
      setChoosing(null);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    const format = formatForUpload(accept, file.type || (isHeic(file) ? "image/heic" : ""));
    if (!format) {
      notify(`Here you can use ${accept.map((f) => MEDIA_RULES[f].noun).join(" or ")}. ${accept.map((f) => MEDIA_RULES[f].hint).join("; ")}.`, "error");
      return;
    }
    setUploading(file.name);
    try {
      // An iPhone photo is converted here when the browser can read it.
      const ready = format === "IMAGE" && isHeic(file) ? await prepareImage(file) : file;
      const problem = headerFileProblem(format, ready) ?? (space ? spaceProblem(ready, space) : null);
      if (problem) {
        notify(problem, "error");
        return;
      }
      const saved = await engageApi.uploadCrmMedia(ready, format === "IMAGE" ? aspect : undefined);
      if (saved.width && saved.originalBytes && saved.originalBytes !== saved.bytes) {
        notify(`Image ready for WhatsApp: ${processedSummary(saved)}.`, "ok");
      }
      setFiles((prev) => [saved, ...prev.filter((f) => f.id !== saved.id)]);
      setSpace((s) => (s ? { ...s, usedBytes: s.usedBytes + saved.bytes } : s));
      // A new upload is what the coach meant to pick.
      await choose(saved);
    } catch (e) {
      notify(e instanceof ApiError || e instanceof Error ? e.message : "Could not upload that file.", "error");
      // The space bar was out of date (another tab uploaded): ask again.
      if (e instanceof ApiError && e.code === "media_quota_exceeded") setReloads((n) => n + 1);
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(ids: string[]) {
    setDeleting(true);
    try {
      const res = await engageApi.deleteCrmMedia(ids);
      const gone = new Set(res.deleted);
      setFiles((prev) => prev.filter((f) => !gone.has(f.id)));
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      setSpace({ usedBytes: res.usedBytes, limitBytes: res.limitBytes });
      setOutcome(res);
      if (res.skipped.length === 0) setSelecting(false);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not delete.", "error");
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const acceptAttr = accept
    .flatMap((f) => (f === "IMAGE" ? [...MEDIA_RULES.IMAGE.types, "image/heic", "image/heif", ".heic", ".heif"] : MEDIA_RULES[f].types))
    .join(",");
  const bar = space ? spaceSummary(space) : null;
  const left = space ? Math.max(0, space.limitBytes - space.usedBytes) : null;
  const confirmFiles = confirm ? files.filter((f) => confirm.includes(f.id)) : [];
  const confirmInUse = confirmFiles.filter((f) => f.inUse);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={title ?? "Choose media"}
      description={
        description ?? (kinds.length === 1 ? MEDIA_RULES[accept[0]].hint : "Pick a file you uploaded before, or upload a new one.")
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
          {bar && space && (
            <div className="min-w-[180px] flex-1" aria-live="polite">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                role="meter"
                aria-label="Media library space"
                aria-valuemin={0}
                aria-valuemax={space.limitBytes}
                aria-valuenow={Math.min(space.usedBytes, space.limitBytes)}
              >
                <div
                  className={`h-full rounded-full ${bar.full ? "bg-live" : bar.fraction > 0.85 ? "bg-warn" : "bg-brand"}`}
                  style={{ width: `${Math.max(2, bar.fraction * 100)}%` }}
                />
              </div>
              <p className={`mt-1 text-[11.5px] ${bar.full ? "text-live" : "text-ink-3"}`}>
                {bar.text}
                {bar.full
                  ? " — full. Your files are kept, but delete some to upload more."
                  : left !== null && ` · one file can be at most the ${spaceSize(left)} left`}
              </p>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={uploading !== null || bar?.full}
              onClick={() => input.current?.click()}
            >
              {uploading ? <Spinner className="size-3.5" /> : <MaterialIcon name="upload" className="!text-[16px]" />}
              Upload from computer
            </Button>
          </div>
        </div>
      }
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept={acceptAttr}
        aria-label="Upload from computer"
        tabIndex={-1}
        onChange={(e) => void upload(e.target.files?.[0])}
      />

      <div
        className={`relative grid gap-3 rounded-xl transition ${dragOver ? "ring-2 ring-brand ring-offset-2 ring-offset-surface" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!bar?.full) void upload(e.dataTransfer.files[0]);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          {tabs.length > 1 && (
            <div role="tablist" aria-label="Kind" className="flex rounded-lg bg-surface-2 p-0.5">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`h-7 rounded-md px-2.5 text-[12.5px] font-medium transition ${
                    tab === t.id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <label htmlFor={searchId} className="sr-only">
            Search by name
          </label>
          <div className="relative min-w-[160px] flex-1">
            <MaterialIcon name="search" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 !text-[16px] text-ink-3" />
            <input
              id={searchId}
              type="search"
              className="field h-8 w-full pl-7"
              placeholder="Search by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant={selecting ? "secondary" : "ghost"}
            onClick={() => {
              setSelecting((v) => !v);
              setSelected(new Set());
              setOutcome(null);
            }}
          >
            <MaterialIcon name={selecting ? "close" : "checklist"} className="!text-[16px]" />
            {selecting ? "Done" : "Select"}
          </Button>
        </div>

        {selecting && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
            <span className="mr-auto">
              {selected.size === 0 ? "Tap files to select them." : `${selected.size} selected`}
            </span>
            {files.length > 0 && (
              <button
                type="button"
                className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                onClick={() =>
                  setSelected(selected.size === files.length ? new Set() : new Set(files.map((f) => f.id)))
                }
              >
                {selected.size === files.length ? "Clear" : "Select all shown"}
              </button>
            )}
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={selected.size === 0 || deleting}
              onClick={() => setConfirm([...selected])}
            >
              <MaterialIcon name="delete" className="!text-[16px]" />
              Delete selected
            </Button>
          </div>
        )}

        {confirm && (
          <div role="alertdialog" aria-label="Delete permanently?" className="grid gap-2 rounded-lg border border-live/30 bg-live-soft px-3 py-2.5 text-[12.5px] text-ink">
            <p className="font-semibold">
              Delete permanently?{" "}
              <span className="font-normal text-ink-2">
                {confirm.length === 1
                  ? `${confirmFiles[0]?.filename || "This file"} will be removed from your library and storage.`
                  : `${confirm.length} files will be removed from your library and storage.`}{" "}
                This can&apos;t be undone.
              </span>
            </p>
            {confirmInUse.length > 0 && (
              <div className="text-ink-2">
                {confirmInUse.length === confirm.length
                  ? confirm.length === 1
                    ? "It is still used, so it will be kept:"
                    : "They are all still used, so they will be kept:"
                  : `${confirmInUse.length} still used will be kept:`}
                <UsageList skipped={confirmInUse.map((f) => ({ id: f.id, filename: f.filename, reason: "in_use", message: "", usages: f.usages }))} />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={deleting} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={deleting || confirmInUse.length === confirm.length}
                onClick={() => void remove(confirm)}
              >
                {deleting && <Spinner className="size-3.5" />}
                Delete
              </Button>
            </div>
          </div>
        )}

        {outcome && (
          <div
            role="status"
            className={`grid gap-1 rounded-lg px-3 py-2 text-[12.5px] ${
              outcome.skipped.length ? "bg-warn-soft text-ink" : "bg-ok-soft text-ink"
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="flex-1">{deleteSummary(outcome)}</span>
              <button type="button" aria-label="Dismiss" className="text-ink-3 hover:text-ink" onClick={() => setOutcome(null)}>
                <MaterialIcon name="close" className="!text-[16px]" />
              </button>
            </div>
            {outcome.skipped.length > 0 && <UsageList skipped={outcome.skipped} />}
          </div>
        )}

        {uploading && (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-2" aria-live="polite">
            <Spinner className="size-3.5" /> Uploading {uploading}…
          </p>
        )}
        {loadError && <p className="text-[12.5px] text-live">{loadError}</p>}

        {files.length === 0 && !loading && !loadError ? (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={bar?.full || uploading !== null}
            className="grid place-items-center gap-1 rounded-xl border-2 border-dashed border-line-2 px-4 py-10 text-center hover:border-ink-3 hover:bg-surface-2"
          >
            <MaterialIcon name="perm_media" className="!text-[28px] text-ink-3" />
            <span className="text-[13px] font-medium text-ink-2">
              {search ? "Nothing matches that name." : "Nothing here yet."}
            </span>
            <span className="text-[12px] text-ink-3">Drop a file here or click to upload one.</span>
          </button>
        ) : (
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4" aria-label="Your media">
            {files.map((f) => (
              <Tile
                key={f.id}
                file={f}
                problem={pickProblem(f, accept, aspect)}
                selecting={selecting}
                selected={selected.has(f.id)}
                busy={choosing === f.id}
                onPick={() => (selecting ? toggle(f.id) : void choose(f))}
                onDelete={() => {
                  setOutcome(null);
                  setConfirm([f.id]);
                }}
              />
            ))}
          </ul>
        )}

        {loading && (
          <p className="flex items-center justify-center gap-2 py-2 text-[12.5px] text-ink-3">
            <Spinner className="size-3.5" /> Loading…
          </p>
        )}
        {cursor && !loading && (
          <div className="flex justify-center">
            <Button type="button" size="sm" variant="secondary" onClick={() => void loadMore(cursor)}>
              Load more
            </Button>
          </div>
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-brand/10 text-[13px] font-semibold text-brand">
            Drop to upload
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Each kept file and where it is still used. */
function UsageList({ skipped }: { skipped: CRMMediaSkipped[] }) {
  return (
    <ul className="mt-1 grid gap-1">
      {skipped.map((s) => (
        <li key={s.id} className="text-[12px]">
          <span className="font-medium text-ink">{s.filename || "A file"}</span>
          {s.usages?.length ? (
            <ul className="ml-4 list-disc text-ink-2">
              {s.usages.map((u, i) => (
                <li key={i}>{usageText(u)}</li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-2"> — {s.message}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Tile({
  file: f,
  problem,
  selecting,
  selected,
  busy,
  onPick,
  onDelete,
}: {
  file: CRMMediaFile;
  problem: string | null;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  const view = f.viewUrl || f.url;
  const blocked = !selecting && problem !== null;
  const usedBy = f.usages?.map((u) => usageText(u)).join("\n");
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onPick}
        disabled={blocked || busy}
        aria-pressed={selecting ? selected : undefined}
        title={blocked ? problem : f.filename}
        className={`flex w-full flex-col overflow-hidden rounded-lg border text-left transition outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
          selected ? "border-brand ring-2 ring-brand" : "border-line hover:border-line-2"
        } ${blocked ? "cursor-not-allowed" : ""}`}
      >
        <div className={`relative aspect-[4/3] w-full bg-surface-2 ${blocked ? "opacity-45" : ""}`}>
          {f.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed bucket link or token link
            <img
              src={f.thumbUrl || view}
              alt=""
              loading="lazy"
              className="absolute inset-0 size-full object-cover"
            />
          ) : f.kind === "video" ? (
            <>
              <video src={view} preload="metadata" muted playsInline className="absolute inset-0 size-full bg-black object-cover" />
              <MaterialIcon name="play_circle" className="absolute right-1.5 bottom-1.5 !text-[20px] text-white drop-shadow" />
            </>
          ) : (
            <span className="absolute inset-0 grid place-items-center">
              <MaterialIcon name="description" className="!text-[34px] text-[#e5533d]" />
            </span>
          )}
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-surface/70">
              <Spinner className="size-5" />
            </span>
          )}
          {selecting && (
            <span
              className={`absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full border-2 ${
                selected ? "border-brand bg-brand text-on-brand" : "border-white bg-black/30"
              }`}
              aria-hidden
            >
              {selected && <MaterialIcon name="check" className="!text-[14px]" />}
            </span>
          )}
          {f.inUse && (
            <span
              className="absolute top-1.5 right-1.5 rounded bg-surface/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-2"
              title={`Used by:\n${usedBy}`}
            >
              In use
            </span>
          )}
        </div>
        <div className="grid gap-0.5 px-2 py-1.5">
          <span className="truncate text-[12px] font-medium text-ink">{f.filename || "Untitled"}</span>
          <span className="truncate text-[11px] text-ink-3">
            {f.width && f.height ? `${f.width}×${f.height} · ` : ""}
            {sizeText(f.bytes)}
            {f.createdAt ? ` · ${uploadedText(f.createdAt)}` : ""}
          </span>
          {blocked && <span className="text-[11px] leading-snug text-warn">{problem}</span>}
        </div>
      </button>
      {!selecting && (
        <button
          type="button"
          aria-label={`Delete ${f.filename || "this file"}`}
          title="Delete"
          onClick={onDelete}
          className="absolute right-1.5 bottom-[52px] grid size-7 place-items-center rounded-md bg-surface/90 text-ink-2 shadow-sm transition hover:text-live focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <MaterialIcon name="delete" className="!text-[16px]" />
        </button>
      )}
    </li>
  );
}
