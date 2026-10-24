/* The Markdown subset blog posts are written in, parsed into a small tree that
 * components/blog/markdown.tsx renders. Hand-rolled rather than a dependency because the
 * subset is small, the output is React elements (so nothing is ever injected as HTML),
 * and it runs at build time only.
 *
 * Blocks
 *   ## Heading / ### Subheading          get ids for the table of contents
 *   paragraphs                           consecutive non-blank lines
 *   - item / 1. item                     one level, no nesting
 *   ~~~lang … ~~~  (or ``` … ```)        code; ~~~ is easier inside a template string
 *   > [!NOTE] / > [!TIP] / > [!WARNING]  callouts; any following "> " lines are the body
 *   > quote                              a plain blockquote
 *   ![alt](/blog/x.png "caption")        an image on its own line
 *   ::diagram[name] caption              a hand-drawn SVG from components/blog/diagrams.tsx
 *   | a | b |  then  |---|---|           a table
 *   ---                                  a rule
 *
 * Inline: **bold**, *italic*, `code`, [text](href). No raw HTML. */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type CalloutKind = "note" | "tip" | "warning";

export type Block =
  | { t: "h"; level: 2 | 3; id: string; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "callout"; kind: CalloutKind; title: string; blocks: Block[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "img"; src: string; alt: string; caption: string }
  | { t: "diagram"; name: string; caption: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/* ------------------------------------------------------------------ inline */

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== " ") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " ") {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = src.indexOf("](", i + 1);
      const end = close > i ? src.indexOf(")", close + 2) : -1;
      if (close > i && end > close) {
        flush();
        out.push({
          t: "link",
          href: src.slice(close + 2, end).trim(),
          c: parseInline(src.slice(i + 1, close)),
        });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : inlineText(n.c)))
    .join("");
}

/** A block's readable text, for word counts and the table of contents. */
export function plainText(b: Block): string {
  switch (b.t) {
    case "h":
    case "p":
      return inlineText(b.c);
    case "ul":
    case "ol":
      return b.items.map(inlineText).join(" ");
    case "code":
      return b.v;
    case "callout":
      return [b.title, ...b.blocks.map(plainText)].join(" ");
    case "quote":
      return b.blocks.map(plainText).join(" ");
    case "img":
      return b.caption;
    case "diagram":
      return b.caption;
    case "table":
      return [...b.head, ...b.rows.flat()].map(inlineText).join(" ");
    case "hr":
      return "";
  }
}

/* ------------------------------------------------------------------ blocks */

const CALLOUT_RE = /^\[!(NOTE|TIP|WARNING)\]\s*(.*)$/i;
const IMG_RE = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/;
const DIAGRAM_RE = /^::diagram\[([a-z0-9-]+)\]\s*(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^(\d+)\.\s+(.*)$/;
const FENCE_RE = /^(~~~|```)\s*([\w-]*)\s*$/;

/** A heading or tag turned into a URL fragment: "Go live — 15 min!" → "go-live-15-min". */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Removes the common leading indentation, so a body can be indented in its source file. */
export function dedent(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const indents = lines
    .filter((l) => l.trim())
    .map((l) => l.match(/^ */)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

export function parseMarkdown(src: string): Block[] {
  const ids = new Map<string, number>();
  return parseLines(dedent(src).split("\n"), ids);
}

function parseLines(lines: string[], ids: Map<string, number>): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  const isBlockStart = (l: string) =>
    /^#{2,3}\s/.test(l) ||
    FENCE_RE.test(l) ||
    l.startsWith(">") ||
    IMG_RE.test(l.trim()) ||
    DIAGRAM_RE.test(l.trim()) ||
    UL_RE.test(l) ||
    OL_RE.test(l) ||
    l.trim() === "---" ||
    l.trim().startsWith("|");

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      const c = parseInline(h[2].trim());
      const base = slugify(inlineText(c)) || "section";
      const n = ids.get(base) ?? 0;
      ids.set(base, n + 1);
      blocks.push({
        t: "h",
        level: h[1].length as 2 | 3,
        id: n ? `${base}-${n + 1}` : base,
        c,
      });
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== fence[1]) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }

    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].startsWith(">"))
        inner.push(lines[i++].replace(/^>\s?/, ""));
      const head = inner[0]?.match(CALLOUT_RE);
      if (head) {
        blocks.push({
          t: "callout",
          kind: head[1].toLowerCase() as CalloutKind,
          title: head[2].trim(),
          blocks: parseLines(inner.slice(1), ids),
        });
      } else {
        blocks.push({ t: "quote", blocks: parseLines(inner, ids) });
      }
      continue;
    }

    const img = trimmed.match(IMG_RE);
    if (img) {
      blocks.push({ t: "img", alt: img[1], src: img[2], caption: img[3] ?? "" });
      i++;
      continue;
    }

    const diagram = trimmed.match(DIAGRAM_RE);
    if (diagram) {
      blocks.push({ t: "diagram", name: diagram[1], caption: diagram[2].trim() });
      i++;
      continue;
    }

    if (trimmed === "---") {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      const [head, sep, ...rest] = rows;
      const hasHead = sep && sep.every((c) => /^:?-+:?$/.test(c));
      // An all-blank header row (| | |) is how a key/value table says "no header".
      const blankHead = head.every((c) => !c);
      blocks.push({
        t: "table",
        head: hasHead && !blankHead ? head.map(parseInline) : [],
        rows: (hasHead ? rest : rows).map((r) => r.map(parseInline)),
      });
      continue;
    }

    const ul = line.match(UL_RE);
    const ol = line.match(OL_RE);
    if (ul || ol) {
      const re = ul ? UL_RE : OL_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (m) {
          items.push(ul ? m[1] : m[2]);
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // An indented line continues the item above it.
          items[items.length - 1] += " " + lines[i].trim();
        } else break;
        i++;
      }
      const parsed = items.map(parseInline);
      blocks.push(ol ? { t: "ol", start: Number(ol[1]), items: parsed } : { t: "ul", items: parsed });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i])))
      para.push(lines[i++].trim());
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}
