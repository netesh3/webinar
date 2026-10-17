/* Where a template's placeholders are, for the screens that fill them.
 *
 * A host picks a value for {{1}}, {{2}}… without seeing the sentence they sit in, and the
 * filled message used to appear only in the preview further down. These helpers cut a
 * template into text and numbered slots so every screen can show the same thing: the
 * sentence with a coloured, numbered chip where each blank is, and the words around it
 * next to the control that fills it.
 *
 * A slot is numbered by what is written inside the braces ({{2}} is slot 2, wherever it
 * appears, and a repeated {{1}} is the same slot). A non-numeric name takes the next
 * number in reading order, which is the server's rule for positional parameters.
 */

export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "slot"; slot: number; raw: string };

const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** The text cut into plain runs and numbered slots, in order. */
export function splitTemplate(text: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let last = 0;
  let unnamed = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    const inner = m[1] ?? "";
    let slot: number;
    if (/^\d+$/.test(inner) && Number(inner) > 0) {
      slot = Number(inner);
    } else {
      unnamed += 1;
      slot = unnamed;
    }
    out.push({ kind: "slot", slot, raw: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** The highest slot number in the text, 0 with none. */
export function slotCount(text: string): number {
  return splitTemplate(text).reduce((n, s) => (s.kind === "slot" ? Math.max(n, s.slot) : n), 0);
}

/** The words either side of a slot's first appearance, so a control can say which blank
 *  it fills ("Hi ___, your webinar"). Other blanks in reach read as "…". Empty strings
 *  when the slot is not in the text. */
export function slotContext(
  text: string,
  slot: number,
  words = 4,
): { before: string; after: string } {
  const segs = splitTemplate(text);
  const at = segs.findIndex((s) => s.kind === "slot" && s.slot === slot);
  if (at < 0) return { before: "", after: "" };
  // Context reads as words: WhatsApp's formatting marks are left out.
  const shown = formatTemplate(text);
  const flatten = (list: FormattedSegment[]) =>
    list.map((s) => (s.kind === "text" ? s.runs.map((r) => r.text).join("") : "…")).join("");
  const beforeWords = flatten(shown.slice(0, at)).split(/\s+/).filter(Boolean);
  const afterWords = flatten(shown.slice(at + 1)).split(/\s+/).filter(Boolean);
  const before = beforeWords.slice(-words).join(" ");
  const after = afterWords.slice(0, words).join(" ");
  return {
    before: (beforeWords.length > words ? "… " : "") + before,
    after: after + (afterWords.length > words ? " …" : ""),
  };
}

/** A run of template text with WhatsApp's *bold* / _italic_ applied and the marks removed. */
export type FormattedRun = { text: string; bold: boolean; italic: boolean };
export type FormattedSegment =
  | { kind: "text"; runs: FormattedRun[] }
  | { kind: "slot"; slot: number; raw: string; bold: boolean; italic: boolean };

/** splitTemplate with WhatsApp formatting resolved across the whole message, so
 *  "*{{2}}*" makes the value bold rather than leaving two stray asterisks. A mark
 *  pairs the way WhatsApp pairs it: an opening and a closing one on the same line. */
export function formatTemplate(text: string): FormattedSegment[] {
  const segs = splitTemplate(text);
  // One character per slot, so a value can sit inside a pair of marks.
  const flat = segs.map((s) => (s.kind === "text" ? s.text : "\u0001")).join("");
  const marks = new Set<number>();
  const bold: boolean[] = new Array(flat.length).fill(false);
  const italic: boolean[] = new Array(flat.length).fill(false);
  for (const [re, into] of [
    [/\*[^*\n]+\*/g, bold],
    [/_[^_\n]+_/g, italic],
  ] as const) {
    for (const m of flat.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length - 1;
      marks.add(start);
      marks.add(end);
      for (let i = start + 1; i < end; i++) into[i] = true;
    }
  }
  const out: FormattedSegment[] = [];
  let at = 0;
  for (const s of segs) {
    if (s.kind === "slot") {
      out.push({ ...s, bold: bold[at], italic: italic[at] });
      at += 1;
      continue;
    }
    const runs: FormattedRun[] = [];
    for (const ch of s.text) {
      if (!marks.has(at)) {
        const last = runs[runs.length - 1];
        if (last && last.bold === bold[at] && last.italic === italic[at]) last.text += ch;
        else runs.push({ text: ch, bold: bold[at], italic: italic[at] });
      }
      at += ch.length;
    }
    out.push({ kind: "text", runs });
  }
  return out;
}

/** How many distinct tones the chips cycle through. */
export const SLOT_TONES = 6;

/** A slot's tone, stable for its number: slot 1 is always the first colour. */
export function slotTone(slot: number): number {
  return (((Math.max(1, Math.floor(slot)) - 1) % SLOT_TONES) + SLOT_TONES) % SLOT_TONES;
}
