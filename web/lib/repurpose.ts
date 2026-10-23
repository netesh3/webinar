/* Content repurposing, the pure half: the formats and their words, what each draft's state
 * says, the download's file name, the character counts a post has to fit, and a small
 * Markdown reader for the preview (headings, lists, paragraphs, bold and italic: what the
 * drafts use), so the preview needs no HTML and no library.
 *
 * Drafts are written by the server (api/internal/api/repurpose.go); nothing here calls a model.
 *
 *   node --experimental-strip-types --no-warnings lib/repurpose.test.mts */
import {
  RepurposeBlog,
  RepurposeInstagram,
  RepurposeLinkedIn,
  RepurposeNewsletter,
  RepurposeWhitepaper,
  RepurposeXThread,
} from "./api-types.ts";
import type { RepurposeDraft } from "./api-types.ts";

export type RepurposeFormat = {
  id: string;
  label: string;
  hint: string;
  /** Plain text where it is pasted (social posts): the preview shows it as it is. */
  plain: boolean;
};

/** Every format, in the order the card offers them. */
export const REPURPOSE_FORMATS: RepurposeFormat[] = [
  { id: RepurposeBlog, label: "Blog post", hint: "700–1,200 words with headings", plain: false },
  { id: RepurposeNewsletter, label: "Newsletter", hint: "A subject line and a short email", plain: false },
  { id: RepurposeWhitepaper, label: "Whitepaper draft", hint: "Long-form, 1,200–2,000 words", plain: false },
  { id: RepurposeLinkedIn, label: "LinkedIn post", hint: "One post, with hashtags", plain: true },
  { id: RepurposeXThread, label: "X thread", hint: "5–10 numbered posts", plain: true },
  { id: RepurposeInstagram, label: "Instagram caption", hint: "A caption and hashtags", plain: true },
];

export function formatLabel(id: string): string {
  return REPURPOSE_FORMATS.find((f) => f.id === id)?.label ?? id;
}

export function isPlainFormat(id: string): boolean {
  return REPURPOSE_FORMATS.find((f) => f.id === id)?.plain ?? false;
}

/** Why drafts cannot be written for this session, in words; null when they can. */
export function repurposeBlockedText(status: string): string | null {
  switch (status) {
    case "ready":
      return null;
    case "not_ended":
      return "Drafts can be written once the session has ended.";
    case "ai_off":
      return "AI isn't switched on for this account.";
    case "ai_session_off":
      return "AI was switched off for this session, so nothing from it goes to the AI.";
    case "no_transcript":
      return "Nothing anyone said in this session was kept, so there is nothing to write from. Keep the room's AI switch on (and microphones on) next time.";
    case "ai_limit":
      return "This month's AI allowance is used up. Drafts can be written again next month.";
    case "ai_unavailable":
      return "AI isn't available right now. Try again in a minute.";
  }
  return "Drafts can't be written for this session right now.";
}

/** Why a draft failed, in words. */
export function draftFailedText(reason: string | undefined): string {
  switch (reason) {
    case "ai_limit":
      return "This month's AI allowance ran out before this draft was written.";
    case "ai_unavailable":
      return "The AI didn't answer after a few tries. Try again in a minute.";
    case "no_transcript":
      return "There was nothing said in the session to write from.";
  }
  return "The draft couldn't be written after a few tries. Try again; if it keeps failing, try a shorter format first.";
}

/** The badge beside a draft: what state it is in, and whether the host has been through it. */
export function draftBadge(d: RepurposeDraft): { text: string; tone: "neutral" | "brand" | "ok" | "warn" | "live" } {
  if (d.status === "writing") return { text: "Writing…", tone: "brand" };
  if (d.status === "queued") return { text: "Waiting to be written", tone: "neutral" };
  if (d.status === "failed") return { text: "Didn't work", tone: "live" };
  if (d.reviewed) return { text: "Reviewed", tone: "ok" };
  return { text: "AI draft, not reviewed", tone: "warn" };
}

/** Whether the card should look again soon: something is still being written. */
export function draftsPending(drafts: readonly RepurposeDraft[]): boolean {
  return drafts.some((d) => d.status === "queued" || d.status === "writing");
}

/** The download's name: format and topic, e.g. "blog-post-money-basics.md". */
export function draftFileName(format: string, topic: string): string {
  const part = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const t = part(topic).slice(0, 40).replace(/-+$/, "");
  return `${part(formatLabel(format))}${t ? `-${t}` : ""}.md`;
}

/** Where a post has to fit: a line under the editor, or null for long-form formats. */
export function lengthNote(format: string, text: string): { text: string; over: boolean } | null {
  const chars = [...text].length;
  if (format === RepurposeXThread) {
    const posts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const over = posts.map((p, i) => ({ i, n: [...p].length })).filter((p) => p.n > 280);
    if (over.length > 0) {
      return {
        text: `Post ${over.map((p) => p.i + 1).join(", ")} ${over.length === 1 ? "is" : "are"} over X's 280 characters.`,
        over: true,
      };
    }
    return { text: `${posts.length} posts, each under 280 characters.`, over: false };
  }
  if (format === RepurposeLinkedIn) return { text: `${chars.toLocaleString("en-US")} of LinkedIn's 3,000 characters.`, over: chars > 3000 };
  if (format === RepurposeInstagram) return { text: `${chars.toLocaleString("en-US")} of Instagram's 2,200 characters.`, over: chars > 2200 };
  return null;
}

// ---------------------------------------------------------------- the preview

export type Inline = { text: string; bold?: boolean; italic?: boolean };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: Inline[] }
  | { kind: "paragraph"; text: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/** **bold** and *italic* (or _italic_) inside a line; everything else is text as it is. */
export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(?<![\w])_([^_]+)_(?![\w])/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2] ?? m[3], italic: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** The draft as blocks for the preview. Plain formats are paragraphs line for line. */
export function markdownBlocks(md: string, plain = false): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: inline(para.join(plain ? "\n" : " ")) });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (plain) {
      para.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: inline(h[2]) });
      continue;
    }
    const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = li[2] !== undefined;
      if (para.length || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(inline(li[3]));
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}
