"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { CheckIcon, ChevronDownIcon, CloseIcon, CopyIcon, SpinnerIcon } from "./icons";

/* Interactive primitives.
 *
 * Split out from ui.tsx because everything here needs state, refs or event
 * handlers — ui.tsx stays importable from a Server Component.
 */

// -------------------------------------------------------------------- spinner

export function Spinner({ className = "size-4" }: { className?: string }) {
  return <SpinnerIcon className={`${className} animate-spin`} />;
}

// ------------------------------------------------------------- escape + click

/** Closes on Escape and on a pointer press outside `ref`.
 *
 *  Pointerdown rather than click: a click fires after the button that opened the
 *  menu has already been re-rendered, which reads as a stray outside-click and
 *  closes the menu the same tick it opened. */
function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ref, open, onClose]);
}

// ---------------------------------------------------------------------- modal

/**
 * A centred dialog on a desktop, a bottom sheet on a phone.
 *
 * One component for both because the content is identical and the only thing
 * that changes is where it is anchored — two components would drift.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dark = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Use the room's dark surface. A white dialog over a near-black video stage is
   *  a flashbang in a session someone has been sitting in for an hour. */
  dark?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const restoreTo = useRef<HTMLElement | null>(null);

  useDismiss(panel, open, onClose);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    // A dialog over a scrolling page that still scrolls behind it feels broken,
    // and on iOS the sheet drifts off screen.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      restoreTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const width = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" }[size];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-ink/45 backdrop-blur-sm" aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl outline-none sm:rounded-2xl ${width} ${
          dark ? "room-dark" : ""
        }`}
      >
        <div className="flex items-start gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15.5px] font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon className="size-4" />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Confirmation for an action that cannot be undone. Separate from Modal so the
 *  wording and the danger styling are consistent everywhere one is needed. */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  busy = false,
  dark = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  dark?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dark={dark}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-line-2 px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-live px-3.5 text-[13px] font-medium text-white hover:bg-live/90 disabled:opacity-50"
          >
            {busy && <Spinner className="size-3.5" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-2">{body}</p>
    </Modal>
  );
}

// --------------------------------------------------------------- icon button

/** A square button that is only an icon, so it always carries a label for
 *  assistive tech and a title for a hovering mouse. */
export function IconButton({
  label,
  active = false,
  tone = "neutral",
  className = "",
  children,
  ...rest
}: ComponentProps<"button"> & {
  label: string;
  active?: boolean;
  tone?: "neutral" | "danger";
}) {
  const base =
    "inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40 disabled:pointer-events-none";
  const tones = {
    neutral: active
      ? "bg-brand-soft text-brand"
      : "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "text-live hover:bg-live-soft",
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={rest["aria-pressed"] ?? (active ? true : undefined)}
      className={`${base} ${tones[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// -------------------------------------------------------------------- toggle

/** A switch. `input type=checkbox` underneath, so it is keyboard operable and
 *  announced correctly without any ARIA of its own. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  tone = "brand",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  tone?: "brand" | "warn";
}) {
  const on = tone === "warn" ? "bg-warn" : "bg-brand";
  return (
    <label
      className={`flex items-start gap-3 rounded-lg px-1 py-2 ${
        disabled ? "opacity-55" : "cursor-pointer hover:bg-surface-2"
      }`}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          className="peer size-0 opacity-0"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden
          className={`block h-[18px] w-[32px] rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${
            checked ? on : "bg-line-2"
          }`}
        />
        <span
          aria-hidden
          className={`absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[14px]" : ""
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------- menu

export type MenuItem =
  | { kind: "separator" }
  | { kind: "label"; text: string }
  | {
      kind: "action";
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
    };

/**
 * A dropdown anchored to its trigger.
 *
 * `align` and `side` exist because the same menu is used in a top nav (opening
 * down) and in a room control bar pinned to the bottom of the viewport (opening
 * up), and a menu that opens off screen is a menu that cannot be used.
 */
export function Menu({
  trigger,
  items,
  align = "end",
  side = "bottom",
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  side?: "top" | "bottom";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);

  const position = [
    side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
    align === "end" ? "right-0" : "left-0",
  ].join(" ");

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-lg"
      >
        {trigger}
      </button>

      {open && (
        <div
          role="menu"
          /* Bounded on both ends, not just a min-width: a hint long enough to
           * need its own line (see below) used to be laid out NEXT to the
           * label instead, so the menu grew exactly as wide as label+hint
           * combined demanded — wide enough, once a hint like "camera, mic,
           * and screen share" landed here, to hang off the left edge of the
           * narrow participants panel this menu opens inside of. That panel
           * scrolls vertically (`overflow-y-auto` in participants.tsx), and
           * the CSS spec computes an implicit `overflow-x: auto` for a box
           * whose overflow-y is non-visible — there is no way to keep the
           * y-scroll without it — so the overhanging part was silently
           * clipped rather than pushed on screen: a label cut down to "Allo…"
           * and a second row missing its label entirely. Capping the width
           * here keeps every menu, whatever its items, inside the space this
           * particular host panel actually has — on a phone's narrower
           * sheet too, where the same math applies at a smaller number. */
          className={`absolute z-50 w-[15.5rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl ${position}`}
        >
          {items.map((item, i) => {
            if (item.kind === "separator") {
              return <div key={i} className="my-1 h-px bg-line" role="separator" />;
            }
            if (item.kind === "label") {
              return (
                <div
                  key={i}
                  className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase"
                >
                  {item.text}
                </div>
              );
            }
            return (
              <button
                key={i}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={`flex w-full min-h-11 items-start gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors disabled:opacity-40 ${
                  item.danger
                    ? "text-live hover:bg-live-soft"
                    : "text-ink hover:bg-surface-2"
                }`}
              >
                {item.icon && <span className="mt-0.5 shrink-0 text-ink-3">{item.icon}</span>}
                {/* Hint stacks under the label instead of beside it — a subtitle,
                    not a trailing column. That is what keeps the menu's width
                    driven by the label alone (see the width comment above), and
                    it reads better on a touch target besides: two short lines are
                    easier to tap and scan than one line eliding the label to fit
                    a number of words squeezed in on the right. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  {item.hint && (
                    <span className="mt-0.5 block text-[11px] text-ink-3">{item.hint}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  counts,
  labels,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (next: T) => void;
  counts?: Partial<Record<T, number>>;
  /** Display text per tab, for when the tab id is not what a person should read
   *  — "qa" is an identifier, "Q&A" is a label. */
  labels?: Partial<Record<T, string>>;
}) {
  return (
    // Horizontally scrollable rather than wrapping: seven tabs on a phone should
    // stay one row you can swipe, not three rows that push the content down.
    <div
      role="tablist"
      className="-mx-1 flex items-center gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = tab === value;
        const count = counts?.[tab];
        return (
          <button
            key={tab}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab)}
            className={`relative -mb-px flex h-10 shrink-0 items-center gap-1.5 px-3.5 text-[13.5px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active ? "font-medium text-brand" : "text-ink-2 hover:text-ink"
            }`}
          >
            {labels?.[tab] ?? tab}
            {count !== undefined && count > 0 && (
              <span
                className={`grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold ${
                  active ? "bg-brand text-white" : "bg-surface-2 text-ink-2"
                }`}
              >
                {count}
              </span>
            )}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-t bg-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- segmented

/** A two-or-three way view switcher — speaker view against gallery view. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            title={o.label}
            className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
              active ? "bg-white/20 text-white" : "text-white/60 hover:text-white"
            }`}
          >
            {o.icon}
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- select

/** A styled native select. Native because a custom listbox on a phone is worse
 *  than the platform's own wheel picker in every way that matters. */
export function Select({
  label,
  value,
  onChange,
  children,
  hint,
  id,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  children: ReactNode;
  hint?: string;
  id?: string;
}) {
  const fallbackId = useId();
  const selectId = id ?? fallbackId;
  return (
    <div>
      <label className="label" htmlFor={selectId}>
        {label}
      </label>
      <div className="relative">
        <select
          id={selectId}
          className="field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
      </div>
      {hint && <p className="mt-1 text-[11.5px] text-ink-3">{hint}</p>}
    </div>
  );
}

// ----------------------------------------------------------------- copy field

/** A read-only value with a copy button, for share links and join keys. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be refused (no permission, insecure origin). The
      // value is visible and selectable, so this is not worth an error state.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div>
      {label && <span className="label">{label}</span>}
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-2">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {copied ? (
            <>
              <CheckIcon className="size-3.5 text-ok" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon className="size-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- alert

export function Alert({
  tone = "info",
  children,
  title,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "border-brand-line bg-brand-soft text-ink-2",
    warn: "border-warn/30 bg-warn-soft text-ink-2",
    error: "border-live/30 bg-live-soft text-ink-2",
    ok: "border-ok/25 bg-ok-soft text-ink-2",
  };
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={`rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed ${tones[tone]}`}
    >
      {title && <strong className="mb-0.5 block text-ink">{title}</strong>}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ disclosure

/** A collapsible section, for the parts of a long form most hosts never open. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-4 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
        {summary}
      </summary>
      <div className="pt-2 pl-6">{children}</div>
    </details>
  );
}
