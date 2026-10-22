"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmModal, Modal, Spinner, Alert } from "../controls";
import { SparklesIcon, TrashIcon } from "../icons";
import { useSession, useToast } from "../providers";
import { Button, ButtonLink, Card, Empty } from "../ui";
import { api } from "@/lib/api";
import {
  FeatureAI,
  FeatureAIKnowledge,
  type KnowledgeDoc,
  type KnowledgeDocDetail,
  type KnowledgeLibrary,
} from "@/lib/api-types";
import {
  folderTag,
  KNOWLEDGE_ACCEPT,
  knowledgeError,
  libraryFull,
  sourceLabel,
  uploadProblem,
  usageLabel,
  VAULT_ACCEPT,
  vaultProblem,
  wordsLabel,
} from "@/lib/knowledge";
import { PastAnswersSection } from "./past-answers";

/* "✨ AI knowledge": the host's library of documents that ground the live Q&A assistant's
 * draft answers. Pasted text or a PDF, Word, text or Markdown upload; the server extracts the
 * text and keeps only that. Every session uses every document unless the host unticks it on
 * that session's Setup tab. See api/internal/api/knowledge.go. */

type AddMode = "paste" | "upload" | "vault";

export function KnowledgeScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const [lib, setLib] = useState<KnowledgeLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<KnowledgeDoc | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDoc | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  // ai_knowledge, which is only in effect with ai; noAI says which of the two is missing.
  const hasAI = (account?.features ?? []).includes(FeatureAIKnowledge);
  const noAI = !(account?.features ?? []).includes(FeatureAI);

  const load = useCallback(async () => {
    try {
      setLib(await api.knowledgeLibrary());
      setLoadError(null);
    } catch (err) {
      setLoadError(knowledgeError(err, "Couldn't load your AI knowledge."));
    }
  }, []);

  useEffect(() => {
    if (!hasAI) return;
    let cancelled = false;
    api
      .knowledgeLibrary()
      .then((res) => {
        if (!cancelled) setLib(res);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(knowledgeError(err, "Couldn't load your AI knowledge."));
      });
    return () => {
      cancelled = true;
    };
  }, [hasAI]);

  async function remove() {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await api.deleteKnowledge(deleting.id);
      notify(`Deleted “${deleting.title}”.`, "info");
      setDeleting(null);
      await load();
    } catch (err) {
      notify(knowledgeError(err, "Couldn't delete that document."), "error");
    } finally {
      setBusyDelete(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }
  if (!account) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">
          Sign in to see your AI knowledge
        </h1>
        <ButtonLink href="/login?next=/host/knowledge" className="mt-5">
          Sign in
        </ButtonLink>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="flex items-center gap-2 text-[28px] font-semibold tracking-[-0.02em]">
        <SparklesIcon className="size-6 text-brand" />
        AI knowledge
      </h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Your course FAQ, policies and notes. During a live session, the Q&amp;A
        assistant drafts answers from these for you to check, edit and post.
        Nothing is posted without you.
      </p>

      {!hasAI ? (
        <div className="mt-6">
          <Empty
            title={noAI ? "AI isn't switched on for this account" : "AI knowledge isn't switched on for this account"}
            hint={noAI ? "AI knowledge is part of the AI features. Ask us to switch AI on for your account." : "Ask us to switch AI knowledge on for your account."}
          />
        </div>
      ) : (
        <>
          {loadError && (
            <div className="mt-5">
              <Alert tone="error">{loadError}</Alert>
            </div>
          )}
          {lib && (
            <>
              <AddDocument
                lib={lib}
                onAdded={(d) => {
                  notify(`Added “${d.title}”: ${wordsLabel(d.words)}.`, "info");
                  void load();
                }}
                onImported={(n) => {
                  notify(
                    `Imported ${n} ${n === 1 ? "note" : "notes"} from your vault.`,
                    "info",
                  );
                  void load();
                }}
              />
              <section aria-label="Your documents" className="mt-6">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-[13px] font-semibold text-ink">
                    Your documents
                  </h2>
                  <p className="text-[12px] text-ink-3 tabular-nums">
                    {usageLabel(lib.docs.length, lib.usedWords, lib.limits)}
                  </p>
                </div>
                {lib.docs.length === 0 ? (
                  <Empty
                    title="No documents yet"
                    hint="Add your course FAQ or a page of common answers. Every session uses them unless you untick one on its Setup tab."
                  />
                ) : (
                  <ul className="grid gap-2.5">
                    {lib.docs.map((d) => (
                      <DocRow
                        key={d.id}
                        doc={d}
                        onView={() => setViewing(d)}
                        onDelete={() => setDeleting(d)}
                        onRenamed={() => void load()}
                      />
                    ))}
                  </ul>
                )}
              </section>
              <PastAnswersSection />
            </>
          )}
          {!lib && !loadError && (
            <div className="grid place-items-center py-16">
              <Spinner className="size-6 text-ink-3" />
            </div>
          )}
        </>
      )}

      <DocText doc={viewing} onClose={() => setViewing(null)} />
      <ConfirmModal
        open={deleting !== null}
        busy={busyDelete}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={`Delete “${deleting?.title ?? ""}”?`}
        body="The assistant stops using it in every session, including live ones. Answers already posted stay as they are."
        confirmLabel="Delete document"
      />
    </div>
  );
}

function AddDocument({
  lib,
  onAdded,
  onImported,
}: {
  lib: KnowledgeLibrary;
  onAdded: (d: KnowledgeDoc) => void;
  onImported: (notes: number) => void;
}) {
  const [mode, setMode] = useState<AddMode>("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const full = libraryFull(lib.docs.length, lib.usedWords, lib.limits);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (mode === "vault") {
      if (!file) {
        setError("Choose your zipped vault.");
        return;
      }
      const problem = vaultProblem(
        file.name,
        file.size,
        lib.limits.maxUploadBytes,
      );
      if (problem) {
        setError(problem);
        return;
      }
      setBusy(true);
      try {
        const res = await api.importVault(file);
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
        onImported(res.docs.length);
      } catch (err) {
        setError(knowledgeError(err, "Couldn't import that vault."));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === "upload") {
      if (!file) {
        setError("Choose a file to upload.");
        return;
      }
      const problem = uploadProblem(
        file.name,
        file.size,
        lib.limits.maxUploadBytes,
      );
      if (problem) {
        setError(problem);
        return;
      }
    } else if (!title.trim() || !text.trim()) {
      setError("Give it a title and paste the text.");
      return;
    }
    setBusy(true);
    try {
      const doc =
        mode === "upload" && file
          ? await api.uploadKnowledge(file, title)
          : await api.addKnowledgeText(title, text);
      setTitle("");
      setText("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      onAdded(doc);
    } catch (err) {
      setError(knowledgeError(err, "Couldn't add that document."));
    } finally {
      setBusy(false);
    }
  }

  const tab = (id: AddMode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === id}
      onClick={() => {
        setMode(id);
        setError(null);
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      }}
      className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        mode === id
          ? "bg-surface text-ink shadow-sm"
          : "text-ink-2 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Card className="mt-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">Add a document</h2>
        <div
          role="tablist"
          aria-label="How to add it"
          className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
        >
          {tab("paste", "Paste text")}
          {tab("upload", "Upload a file")}
          {tab("vault", "✨ Obsidian vault")}
        </div>
      </div>
      {full ? (
        <div className="mt-3">
          <Alert tone="warn">
            Your AI knowledge is full. Delete a document to add another.
          </Alert>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-3 grid gap-3">
          {mode === "vault" ? (
            <div>
              <label className="label" htmlFor="kb-vault">
                Zipped vault
              </label>
              <input
                ref={fileInput}
                id="kb-vault"
                type="file"
                accept={VAULT_ACCEPT}
                className="block w-full text-[13px] text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium file:text-ink hover:file:bg-surface-2"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
              <p className="mt-1 text-[11.5px] text-ink-3">
                Zip your vault&apos;s folder (up to{" "}
                {Math.floor(lib.limits.maxUploadBytes / (1 << 20))} MB). Each
                note becomes a document, tagged with its folder; front-matter is
                dropped and [[links]] become plain words. Settings (.obsidian),
                pictures and empty notes are skipped. The notes must fit your
                library:{" "}
                {usageLabel(lib.docs.length, lib.usedWords, lib.limits)}.
              </p>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="kb-title">
                Title
                {mode === "upload" &&
                  " (optional: the file name is used otherwise)"}
              </label>
              <input
                id="kb-title"
                className="field"
                value={title}
                maxLength={120}
                placeholder="Course FAQ"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          )}
          {mode === "vault" ? null : mode === "paste" ? (
            <div>
              <label className="label" htmlFor="kb-text">
                Text
              </label>
              <textarea
                id="kb-text"
                className="field min-h-40"
                rows={8}
                value={text}
                placeholder="Fees, batch timings, refund policy, what's in each module… Hinglish is fine."
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="kb-file">
                File
              </label>
              <input
                ref={fileInput}
                id="kb-file"
                type="file"
                accept={KNOWLEDGE_ACCEPT}
                className="block w-full text-[13px] text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium file:text-ink hover:file:bg-surface-2"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
              <p className="mt-1 text-[11.5px] text-ink-3">
                PDF, Word (.docx), .txt or .md, up to{" "}
                {Math.floor(lib.limits.maxUploadBytes / (1 << 20))} MB and{" "}
                {wordsLabel(lib.limits.maxDocWords)}. Only the text is kept; a
                scanned PDF has none.
              </p>
            </div>
          )}
          {error && <p className="text-[12.5px] text-live">{error}</p>}
          <div>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              {mode === "vault"
                ? "Import notes"
                : mode === "upload"
                  ? "Upload"
                  : "Add document"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function DocRow({
  doc,
  onView,
  onDelete,
  onRenamed,
}: {
  doc: KnowledgeDoc;
  onView: () => void;
  onDelete: () => void;
  onRenamed: () => void;
}) {
  const { notify } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState(false);

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api.renameKnowledge(doc.id, title);
      setEditing(false);
      onRenamed();
    } catch (err) {
      notify(knowledgeError(err, "Couldn't rename that document."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <Card className="px-4 py-3">
        {editing ? (
          <form
            onSubmit={(e) => void rename(e)}
            className="flex flex-wrap items-center gap-2"
          >
            <label className="sr-only" htmlFor={`kb-rename-${doc.id}`}>
              Title
            </label>
            <input
              id={`kb-rename-${doc.id}`}
              className="field min-w-0 flex-1"
              value={title}
              maxLength={120}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setTitle(doc.title);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium break-words text-ink">
                {doc.title}
                {folderTag(doc.folder) && (
                  <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-ink-2">
                    {folderTag(doc.folder)}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[12px] text-ink-3">
                {sourceLabel(doc.source)}
                {doc.filename && doc.source !== "text" && (
                  <> · {doc.filename}</>
                )}{" "}
                · {wordsLabel(doc.words)} · added{" "}
                {new Date(doc.createdAt).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" onClick={onView}>
                View text
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                aria-label={`Delete ${doc.title}`}
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>
          </div>
        )}
        {doc.preview && (
          <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed break-words text-ink-2">
            {doc.preview}
          </p>
        )}
      </Card>
    </li>
  );
}

/** The extracted text, so a host can see what the assistant reads (and that a PDF read well). */
function DocText({
  doc,
  onClose,
}: {
  doc: KnowledgeDoc | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<KnowledgeDocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = doc?.id;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .knowledgeDoc(id)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(knowledgeError(err, "Couldn't load the text."));
      });
    return () => {
      cancelled = true;
      setDetail(null);
    };
  }, [id]);

  return (
    <Modal
      open={doc !== null}
      onClose={onClose}
      title={doc?.title ?? ""}
      description={
        doc
          ? `${sourceLabel(doc.source)} · ${wordsLabel(doc.words)} · the text the assistant reads`
          : undefined
      }
      size="lg"
    >
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : detail && detail.doc.id === id ? (
        <>
          <pre className="max-h-[60vh] overflow-y-auto rounded-lg bg-surface-2 p-3 font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink">
            {detail.text}
          </pre>
          {detail.truncated && (
            <p className="mt-2 text-[11.5px] text-ink-3">
              Showing the start. The assistant reads all of it.
            </p>
          )}
        </>
      ) : (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-3" />
        </div>
      )}
    </Modal>
  );
}
