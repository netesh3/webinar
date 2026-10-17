/* A template's default field mapping, on the browser side.
 *
 * Each template carries what fills its {{1}}, {{2}}… unless one use says otherwise
 * (CRMTemplate.defaultParams; defaultParamsSaved when the host saved it, otherwise a
 * suggestion read off the wording).
 *
 * Two kinds of use:
 *   - reminders, webinar message slots and sequence steps saved with NO values follow the
 *     template: the server fills them in from the mapping when each message is queued, so a
 *     later change to the mapping reaches them ("Template defaults").
 *   - a use saved with values keeps them ("Customised"). Broadcasts and one-off sends are
 *     always this kind: prefilled from the mapping, then sent as they are.
 *
 * And the editor helpers behind "Insert field": a blank is numbered by reading order, so
 * inserting one in the middle renumbers those after it, and the mapping moves with them.
 *
 * No imports but types, so node runs the tests as they are.
 */
import type {
  CRMMergeField,
  CRMParam,
  CRMTemplate,
  NotificationKind,
} from "../lib/api-types";

/** Whether a field has a value on this kind of message. Without a kind, any field. */
export function fieldWorksIn(
  token: string,
  kind: NotificationKind | "" | undefined,
  fields: Pick<CRMMergeField, "token" | "onlyKind">[],
): boolean {
  const f = fields.find((x) => x.token === token);
  if (!f) return false;
  return !f.onlyKind || !kind || f.onlyKind === kind;
}

type Mapped = Pick<CRMTemplate, "variables" | "defaultParams">;

/** The template's mapping as params for one kind of message: an entry whose field has no
 *  value here takes `fallback`'s entry for that blank. */
export function mappingParams(
  t: Mapped,
  kind: NotificationKind | "" | undefined,
  fields: Pick<CRMMergeField, "token" | "onlyKind">[],
  fallback: CRMParam[] = [],
): CRMParam[] {
  const saved = t.defaultParams ?? [];
  return Array.from({ length: t.variables }, (_, i) => {
    const p = saved[i];
    if (p?.field && fieldWorksIn(p.field, kind, fields)) return { field: p.field };
    if (!p?.field && p?.text?.trim()) return { text: p.text };
    return fallback[i] ?? { field: "" };
  });
}

/** The same as field tokens, for the uses that store tokens (reminders, slots): words are
 *  not a token, so that blank takes the fallback. */
export function mappingTokens(
  t: Mapped,
  kind: NotificationKind | "" | undefined,
  fields: Pick<CRMMergeField, "token" | "onlyKind">[],
  fallback: string[] = [],
): string[] {
  const saved = t.defaultParams ?? [];
  return Array.from({ length: t.variables }, (_, i) => {
    const f = saved[i]?.field;
    return f && fieldWorksIn(f, kind, fields) ? f : (fallback[i] ?? "");
  });
}

/** A use saved with no values follows its template. */
export function followsTemplate(params: readonly unknown[] | null | undefined, variables: number): boolean {
  return variables > 0 && (!params || params.length === 0);
}

/** Whether these values are exactly the template's, so saving them as "follow the
 *  template" changes nothing a recipient would read today. */
export function sameAsDefaults(values: CRMParam[], defaults: CRMParam[]): boolean {
  if (values.length !== defaults.length) return false;
  return values.every((v, i) => {
    const d = defaults[i];
    if (v.field || d.field) return (v.field ?? "") === (d.field ?? "");
    return (v.text ?? "").trim() === (d.text ?? "").trim();
  });
}

/* ---------------------------------------------------------------- the editor */

/** One blank's entry while writing: what fills it, or null when nothing was chosen. */
export type Draft = CRMParam | null;

const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;
const INSERTING = "\u0000new";

/** Renumber the blanks in reading order ({{3}} … {{1}} becomes {{1}} … {{2}}), carrying each
 *  blank's entry with it. A repeated {{n}} stays one blank. A number with no entry — typed by
 *  hand — is left unmapped. `at` is a position in `body`, returned moved to match. */
export function renumber(
  body: string,
  mapping: Draft[],
  at = body.length,
  inserted: Draft = null,
): { body: string; mapping: Draft[]; at: number } {
  const assigned = new Map<string, number>();
  const next: Draft[] = [];
  let out = "";
  let last = 0;
  let movedAt = at;
  for (const m of body.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    const inner = (m[1] ?? "").trim();
    out += body.slice(last, start);
    // A named blank ({{name}}) is its own blank each time; numbers are shared.
    const key = /^\d+$/.test(inner) || inner === INSERTING ? inner : `${inner}@${start}`;
    let n = assigned.get(key);
    if (n === undefined) {
      n = assigned.size + 1;
      assigned.set(key, n);
      if (inner === INSERTING) next.push(inserted);
      else if (/^\d+$/.test(inner)) next.push(mapping[Number(inner) - 1] ?? null);
      else next.push(null);
    }
    const written = `{{${n}}}`;
    out += written;
    const end = start + m[0].length;
    if (at >= end) movedAt += written.length - m[0].length;
    last = end;
  }
  out += body.slice(last);
  return { body: out, mapping: next, at: Math.max(0, Math.min(movedAt, out.length)) };
}

/** Insert the next blank at `at`, filled by `entry`: numbered by where it lands, with the
 *  blanks after it renumbered. Returns the cursor just after the new blank. */
export function insertField(
  body: string,
  at: number,
  mapping: Draft[],
  entry: CRMParam,
): { body: string; mapping: Draft[]; at: number } {
  const pos = Math.max(0, Math.min(at, body.length));
  const marker = `{{${INSERTING}}}`;
  const withMarker = body.slice(0, pos) + marker + body.slice(pos);
  return renumber(withMarker, mapping, pos + marker.length, entry);
}

/** The blank numbers (1-based) in the text with nothing chosen for them. */
export function unmappedBlanks(body: string, mapping: Draft[]): number[] {
  const seen = new Set<number>();
  for (const m of body.matchAll(PLACEHOLDER)) {
    const inner = (m[1] ?? "").trim();
    if (/^\d+$/.test(inner) && Number(inner) > 0) seen.add(Number(inner));
  }
  return [...seen].sort((a, b) => a - b).filter((n) => {
    const p = mapping[n - 1];
    return !p || (!p.field && !(p.text ?? "").trim());
  });
}

/** What the preview shows in each blank while writing: the mapped field's example, or the
 *  words; "" for an unmapped blank, which the preview draws as a warning chip. */
export function draftValues(
  body: string,
  mapping: Draft[],
  fields: Pick<CRMMergeField, "token" | "example">[],
): string[] {
  let count = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    const inner = (m[1] ?? "").trim();
    if (/^\d+$/.test(inner)) count = Math.max(count, Number(inner));
  }
  return Array.from({ length: count }, (_, i) => {
    const p = mapping[i];
    if (p?.field) return fields.find((f) => f.token === p.field)?.example || "";
    return (p?.text ?? "").trim();
  });
}

/** The mapping to submit with new wording: one entry per blank, an open one left empty for
 *  the server to suggest. Nothing when the host chose nothing. */
export function mappingForSubmit(body: string, mapping: Draft[]): CRMParam[] | undefined {
  const blanks = new Set<number>();
  for (const m of body.matchAll(PLACEHOLDER)) {
    const inner = (m[1] ?? "").trim();
    if (/^\d+$/.test(inner) && Number(inner) > 0) blanks.add(Number(inner));
  }
  const count = blanks.size ? Math.max(...blanks) : 0;
  const out = Array.from({ length: count }, (_, i) => mapping[i] ?? {});
  return out.some((p) => p.field || p.text?.trim()) ? out : undefined;
}
