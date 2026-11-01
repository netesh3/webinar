/* The "Compare all features" table's sections as an accordion (2 Nov 2026): every section starts
 * collapsed, a header opens or closes its own, "Expand all" opens every one, and a link to
 * #compare-<section> opens that section. Pure, so it is tested on its own
 * (compare-accordion.test.mts); components/marketing/plans-ui.tsx draws it. */

/** The anchor of one section: #compare-capacity, #compare-ai, ... */
export function sectionAnchor(id: string): string {
  return `compare-${id}`;
}

/** The section a location hash names, or null: "#compare-ai" is "ai" when ai is a section. */
export function sectionFromHash(hash: string, ids: readonly string[]): string | null {
  const m = /^#compare-([a-z0-9-]+)$/.exec(hash.trim());
  return m && ids.includes(m[1]) ? m[1] : null;
}

/** The open set after a header is pressed: that section flips, the others stay. */
export function toggleSection(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Whether every section is open, for the label of the Expand all / Collapse all control. */
export function allOpen(open: ReadonlySet<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => open.has(id));
}

/** The open set after Expand all (every section) or Collapse all (none). */
export function setAll(ids: readonly string[], expand: boolean): Set<string> {
  return expand ? new Set(ids) : new Set();
}

/** The count a collapsed header shows: "4 features", "1 feature". */
export function rowCountLabel(n: number): string {
  return `${n} ${n === 1 ? "feature" : "features"}`;
}
