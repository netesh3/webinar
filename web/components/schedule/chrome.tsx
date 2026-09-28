"use client";

import { useId, type ReactNode } from "react";
import { Card } from "../ui";

export const groupId = (label: string) =>
  `settings-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;

export function FormGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div id={groupId(label)} className="scroll-mt-20">
      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.07em] text-ink-3 uppercase">
        {label}
      </h2>
      <Card>{children}</Card>
    </div>
  );
}

export function FormSection({
  title,
  description,
  first,
  children,
}: {
  title: string;
  description: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`grid gap-3 px-4 py-5 lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-6 lg:py-6 ${
        first ? "" : "border-t border-line"
      }`}
    >
      <div>
        <h3 className="text-[14px] font-semibold tracking-[-0.005em] text-ink">
          {title}
        </h3>
        <p className="mt-1 text-[12px] leading-normal text-ink-3">
          {description}
        </p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Boxed({
  on,
  className = "",
  children,
}: {
  on: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[10px] border px-1.5 py-0.5 ${
        on ? "border-brand-line bg-brand-soft" : "border-line bg-surface"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Text({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  required,
  large,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  large?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`field ${large ? "field-lg" : ""} ${error ? "border-live" : ""}`}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="mt-1 text-[12px] font-medium text-live">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}
