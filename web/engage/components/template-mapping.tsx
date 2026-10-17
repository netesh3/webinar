"use client";

import { useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Badge, Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  NotifyWhatsAppBroadcast,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  type CRMMergeField,
  type CRMParam,
  type CRMTemplate,
  type NotificationKind,
} from "@/lib/api-types";
import {
  insertField,
  renumber,
  sameAsDefaults,
  unmappedBlanks,
  type Draft,
} from "../template-mapping";
import { paramView, slotControlId, SlotChip, TemplateBlanks, tokenView } from "./template-params";

/* The template's default field mapping, where a host sets it (the templates page, and the
 * editor they write wording in) and where each use shows whether it follows it. The pure
 * rules are in ../template-mapping.ts. */

/** Where a field has a value, in words: the replay link only on the replay message, and
 *  so on. Shown beside each blank so the mapping says where it will work. */
export function fieldContexts(field: CRMMergeField | undefined): string {
  if (!field) return "";
  switch (field.onlyKind) {
    case NotifyWhatsAppReminder:
      return "Only in timed reminders — other messages use the suggestion here";
    case NotifyWhatsAppReplay:
      return "Only in the replay message — other messages use the suggestion here";
    case NotifyWhatsAppBroadcast:
      return "Only in broadcasts sent after a webinar";
    case undefined:
    case "":
      return field.token === "topic" || field.token === "when" || field.token === "join_link" ||
        field.token === "webinar_link"
        ? "Every message about a webinar"
        : "Every message";
    default:
      return "Only on some messages";
  }
}

const WORDS = "__words__";

/** One blank's choice: a field, or the same words for everybody. */
export function FieldPicker({
  id,
  value,
  fields,
  onChange,
  allowWords = true,
  disabled,
}: {
  id?: string;
  value: CRMParam | null | undefined;
  fields: CRMMergeField[];
  onChange: (next: CRMParam) => void;
  allowWords?: boolean;
  disabled?: boolean;
}) {
  const words = !value?.field && value?.text !== undefined;
  const selected = value?.field ? value.field : words ? WORDS : "";
  return (
    <div className="grid gap-1.5">
      <select
        id={id}
        className="field h-8 text-[12.5px]"
        value={selected}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === WORDS ? { text: value?.text ?? "" } : { field: v });
        }}
      >
        <option value="" disabled>
          Choose what fills it…
        </option>
        {fields.map((f) => (
          <option key={f.token} value={f.token}>
            {f.label}
            {f.onlyKind ? " (some messages only)" : ""}
          </option>
        ))}
        {allowWords && <option value={WORDS}>Words I type…</option>}
      </select>
      {words && (
        <input
          className="field h-8 text-[12.5px]"
          value={value?.text ?? ""}
          disabled={disabled}
          placeholder="The same words for everybody"
          onChange={(e) => onChange({ text: e.target.value })}
          aria-label="Words for this blank"
        />
      )}
    </div>
  );
}

/** "Template defaults" or "Customised", and the way back to the template's. */
export function DefaultsBadge({
  inherits,
  onReset,
  disabled,
}: {
  inherits: boolean;
  onReset?: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {inherits ? (
        <Badge tone="brand">Template defaults</Badge>
      ) : (
        <Badge tone="neutral">Customised</Badge>
      )}
      {!inherits && onReset && (
        <button
          type="button"
          className="text-[12px] font-medium text-brand hover:underline disabled:opacity-50"
          onClick={onReset}
          disabled={disabled}
        >
          Reset to template defaults
        </button>
      )}
    </span>
  );
}

/** A use's blanks, for the uses that store field tokens (automatic messages, webinar
 *  message slots): following the template's mapping (saved as no values) until the host
 *  changes one, then customised; Reset goes back to following it. */
export function UseBlanks({
  template,
  kind,
  params,
  defaults,
  fields,
  onChange,
  controlPrefix,
  disabled,
}: {
  template: CRMTemplate;
  kind: NotificationKind;
  /** As saved: empty follows the template. */
  params: string[];
  /** The template's values for this kind of message (templateTokens). */
  defaults: string[];
  fields: CRMMergeField[];
  onChange: (next: string[]) => void;
  controlPrefix: string;
  disabled?: boolean;
}) {
  if (template.variables === 0) return null;
  const inherits = params.length === 0;
  const shown = inherits ? defaults : params;
  const usable = fields.filter((f) => !f.onlyKind || f.onlyKind === kind);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink-2">What fills the blanks</span>
        <DefaultsBadge inherits={inherits} onReset={() => onChange([])} disabled={disabled} />
      </div>
      <TemplateBlanks
        body={template.body ?? ""}
        views={Array.from({ length: template.variables }, (_, i) => tokenView(shown[i], fields))}
        controlPrefix={controlPrefix}
        control={(i) => (
          <select
            id={slotControlId(controlPrefix, i + 1)}
            className="field h-8 text-[12.5px]"
            value={shown[i] ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const next = Array.from({ length: template.variables }, (_, j) => shown[j] ?? "");
              next[i] = e.target.value;
              onChange(next);
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
            {usable.map((f) => (
              <option key={f.token} value={f.token}>
                {f.label}
              </option>
            ))}
          </select>
        )}
      />
    </div>
  );
}

/** What the template fills in by itself, beyond its body's blanks — said, not editable. */
function AutomaticParts({ template }: { template: CRMTemplate }) {
  const notes: string[] = [];
  for (const b of template.buttons ?? []) {
    if (b.type === "URL" && b.dynamic) {
      notes.push(
        `“${b.text}” button: filled automatically with each person's own join link (the replay link on the replay message).`,
      );
    }
    if (b.type === "COPY_CODE") {
      notes.push(
        `“${b.text}” button: sends ${template.couponCode ? `the code ${template.couponCode}` : "the coupon set for this template"}; a broadcast can change it.`,
      );
    }
  }
  if (template.offer?.hasExpiration) {
    notes.push("Offer expiry: set on each broadcast that sends it.");
  }
  if ((template.cards?.length ?? 0) > 0) {
    notes.push("Card pictures: set on the template; card wording is sent as approved.");
  }
  if (notes.length === 0) return null;
  return (
    <ul className="grid gap-1 text-[11.5px] text-ink-3">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/** The Field mapping section of a template: what fills each blank wherever it is used,
 *  unless that use chose its own. Saved here; nothing is resubmitted to Meta. */
export function TemplateFieldMapping({
  template,
  fields,
  onSaved,
}: {
  template: CRMTemplate;
  fields: CRMMergeField[];
  onSaved: (saved: CRMTemplate) => void;
}) {
  const { notify } = useToast();
  const initial = (template.defaultParams ?? []).slice(0, template.variables);
  const [params, setParams] = useState<CRMParam[]>(initial);
  const [busy, setBusy] = useState(false);
  const key = `${template.name}/${template.language}/${JSON.stringify(template.defaultParams ?? [])}`;
  const lastKey = useRef(key);
  useEffect(() => {
    // Another template picked, or this one saved: start from what the server says.
    if (lastKey.current !== key) {
      lastKey.current = key;
      setParams((template.defaultParams ?? []).slice(0, template.variables));
    }
  }, [key, template.defaultParams, template.variables]);

  if (template.variables === 0) {
    return (
      <section className="grid gap-2 rounded-xl border border-line px-3 py-2.5">
        <h3 className="text-[13px] font-semibold">Field mapping</h3>
        <p className="text-[12px] text-ink-3">This template has no blanks to fill.</p>
        <AutomaticParts template={template} />
      </section>
    );
  }

  const dirty = !sameAsDefaults(params, initial) || !template.defaultParamsSaved;
  const incomplete = params.length !== template.variables ||
    params.some((p) => !p.field && !(p.text ?? "").trim());
  const prefix = `map-${template.name}-${template.language}`;

  async function save() {
    setBusy(true);
    try {
      const saved = await engageApi.setCrmTemplateMapping(template.name, template.language, params);
      notify("Field mapping saved. Messages that use this template's defaults follow it.", "ok");
      onSaved(saved);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not save the mapping.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-2 rounded-xl border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Field mapping</h3>
        {template.defaultParamsSaved ? (
          <Badge tone="ok">Saved</Badge>
        ) : (
          <Badge tone="warn">Suggested</Badge>
        )}
      </div>
      <p className="text-[11.5px] text-ink-3">
        What fills each blank wherever this template is used. A message you customised keeps its own
        choices. Changing this does not resubmit the template to Meta.
      </p>
      <TemplateBlanks
        body={template.body ?? ""}
        views={Array.from({ length: template.variables }, (_, i) => paramView(params[i], fields))}
        controlPrefix={prefix}
        control={(i) => {
          const field = fields.find((f) => f.token === params[i]?.field);
          return (
            <div className="grid gap-1">
              <FieldPicker
                id={slotControlId(prefix, i + 1)}
                value={params[i]}
                fields={fields}
                disabled={busy}
                onChange={(next) =>
                  setParams((prev) => {
                    const out = Array.from({ length: template.variables }, (_, j) => prev[j] ?? {});
                    out[i] = next;
                    return out;
                  })
                }
              />
              {field && <span className="text-[11px] text-ink-3">{fieldContexts(field)}</span>}
            </div>
          );
        }}
      />
      <AutomaticParts template={template} />
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={busy || incomplete || !dirty}>
          {busy && <Spinner className="size-3.5" />}
          {template.defaultParamsSaved ? "Save mapping" : "Save as this template's mapping"}
        </Button>
      </div>
    </section>
  );
}

/** The wording textarea with "Insert field": puts the next {{n}} at the cursor and
 *  remembers what fills it. A {{n}} typed by hand is left open, with a prompt to map it.
 *  Blanks are renumbered in reading order when the field loses focus. */
export function WordingWithFields({
  value,
  onChange,
  mapping,
  onMapping,
  fields,
  className,
  rows,
  maxLength,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  mapping: Draft[];
  onMapping: (next: Draft[]) => void;
  fields: CRMMergeField[];
  className?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);
  const open = unmappedBlanks(value, mapping);

  useEffect(() => {
    if (cursor.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
  }, [value]);

  function insert(token: string) {
    const at = ref.current?.selectionStart ?? value.length;
    const next = insertField(value, at, mapping, { field: token });
    cursor.current = next.at;
    onMapping(next.mapping);
    onChange(next.body);
  }

  function tidy() {
    const next = renumber(value, mapping);
    if (next.body !== value) onChange(next.body);
    onMapping(next.mapping);
  }

  return (
    <div className="grid gap-1.5">
      <textarea
        ref={ref}
        className={className ?? "field min-h-24 w-full resize-y py-2"}
        rows={rows}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        onBlur={tidy}
        placeholder={placeholder}
        aria-label="Your wording"
        disabled={disabled}
      />
      {fields.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="field h-7 w-auto text-[12px]"
            value=""
            disabled={disabled}
            aria-label="Insert field"
            // The textarea keeps its selection while this has focus, so the blank lands
            // where the cursor was; insertField renumbers the whole text itself.
            onChange={(e) => {
              if (e.target.value) insert(e.target.value);
            }}
          >
            <option value="">+ Insert field</option>
            {fields.map((f) => (
              <option key={f.token} value={f.token}>
                {f.label}
              </option>
            ))}
          </select>
          {Array.from({ length: Math.max(0, mapping.length) }, (_, i) => i + 1)
            .filter((n) => value.includes(`{{${n}}}`) && !open.includes(n))
            .map((n) => (
              <SlotChip key={n} slot={n} view={paramView(mapping[n - 1] ?? undefined, fields)} />
            ))}
        </div>
      )}
      {open.length > 0 && fields.length > 0 && (
        <div className="grid gap-1.5 rounded-lg border border-dashed border-warn/50 bg-warn-soft/40 px-2.5 py-2">
          <p className="text-[12px] text-ink-2">
            {open.map((n) => `{{${n}}}`).join(", ")} {open.length === 1 ? "isn't" : "aren't"} mapped
            yet. Pick what fills {open.length === 1 ? "it" : "each"}, or leave it and the app suggests one.
          </p>
          {open.map((n) => (
            <div key={n} className="flex items-center gap-2">
              <SlotChip slot={n} numberOnly />
              <div className="min-w-0 flex-1">
                <FieldPicker
                  value={mapping[n - 1]}
                  fields={fields}
                  disabled={disabled}
                  onChange={(p) => {
                    const out = [...mapping];
                    while (out.length < n) out.push(null);
                    out[n - 1] = p;
                    onMapping(out);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
