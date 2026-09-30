"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "@/components/icons";
import {
  cycleColumnSort,
  type ColumnSort,
  type SortDir,
} from "@/lib/table-sort";

/* One header for every sortable column.
 *
 * The first click sorts (names and dates ascending, counts descending — the
 * caller picks). The second flips direction. The third returns to the table's
 * own order, unless the table always has a sort, in which case it toggles.
 * The active column shows its arrow; the others reveal a faint one on hover. */

export function useSort<K extends string>(options?: {
  defaultDir?: Partial<Record<K, SortDir>>;
  /** Third click clears the sort. Tables that must always name a column pass false. */
  reset?: boolean;
}) {
  const [sort, setSort] = useState<ColumnSort<K>>({ key: null, dir: "asc" });
  const reset = options?.reset !== false;
  const defaults = options?.defaultDir;

  function onSort(key: K): ColumnSort<K> {
    const next = cycleColumnSort(sort, key, {
      defaultDir: defaults?.[key] ?? "asc",
      reset,
    });
    setSort(next);
    return next;
  }

  return { sort, onSort };
}

function SortMark({ active, dir }: { active: boolean; dir: SortDir }) {
  const Icon = dir === "desc" ? ArrowDownIcon : ArrowUpIcon;
  return (
    <Icon
      className={`size-3 shrink-0 ${
        active
          ? "text-brand"
          : "text-ink-3 opacity-0 group-hover:opacity-40 group-focus-visible:opacity-40"
      }`}
    />
  );
}

export function SortHeader({
  label,
  active,
  dir,
  onSort,
  hintDir = "asc",
  align = "left",
  className = "",
  as = "th",
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  /** Arrow shown on an inactive header: the direction the first click will use. */
  hintDir?: SortDir;
  align?: "left" | "right";
  className?: string;
  /** `th` inside a table. `columnheader` for a flex row that is still a column header. */
  as?: "th" | "columnheader";
}) {
  const ariaSort = active ? (dir === "asc" ? "ascending" : "descending") : "none";
  const button = (
    <button
      type="button"
      onClick={onSort}
      className={`group inline-flex max-w-full items-center gap-1 rounded font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1 ${
        active ? "text-ink" : ""
      } ${align === "right" ? "w-full justify-end" : ""}`}
    >
      <span className="truncate">{label}</span>
      <SortMark active={active} dir={active ? dir : hintDir} />
    </button>
  );
  if (as === "columnheader") {
    return (
      <div role="columnheader" aria-sort={ariaSort} className={className}>
        {button}
      </div>
    );
  }
  return (
    <th scope="col" aria-sort={ariaSort} className={className}>
      {button}
    </th>
  );
}
