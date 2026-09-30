/* Click-to-sort for every data table.
 *
 * Strings compare case-insensitively. Numbers and instants compare as numbers,
 * not as their printed form, so 10 stays after 2 and a later timestamp stays
 * after an earlier one. Empty values stay at the end in both directions.
 * Equal values keep their original order. */

export type SortDir = "asc" | "desc";
export type SortKind = "string" | "number" | "date";
export type SortValue = string | number | null | undefined;

export interface ColumnSort<K extends string> {
  /** Null is the table's own default order — no column is active. */
  key: K | null;
  dir: SortDir;
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

export function cycleColumnSort<K extends string>(
  current: ColumnSort<K>,
  key: K,
  opts?: { defaultDir?: SortDir; reset?: boolean },
): ColumnSort<K> {
  const first = opts?.defaultDir ?? "asc";
  const opposite: SortDir = first === "asc" ? "desc" : "asc";
  if (current.key !== key) return { key, dir: first };
  if (current.dir === first) return { key, dir: opposite };
  if (opts?.reset === false) return { key, dir: first };
  return { key: null, dir: first };
}

function present(value: SortValue, kind: SortKind): number | string | null {
  if (kind === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  if (kind === "date") {
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Negative when a belongs before b. Empty values compare as after any real value. */
export function compareSortValues(
  a: SortValue,
  b: SortValue,
  kind: SortKind,
  dir: SortDir,
): number {
  const av = present(a, kind);
  const bv = present(b, kind);
  if (av == null || bv == null) {
    if (av == null && bv == null) return 0;
    return av == null ? 1 : -1;
  }
  const sign = dir === "asc" ? 1 : -1;
  if (typeof av === "number" && typeof bv === "number") return sign * (av - bv);
  return sign * collator.compare(String(av), String(bv));
}

export function sortBy<T>(
  rows: readonly T[],
  dir: SortDir,
  value: (row: T) => SortValue,
  kind: SortKind,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const cmp = compareSortValues(value(x.row), value(y.row), kind, dir);
      return cmp !== 0 ? cmp : x.index - y.index;
    })
    .map((item) => item.row);
}
