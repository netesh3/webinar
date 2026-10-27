"use client";

/* The captions language select: in the scheduling form ("Recording and extras") and in the
 * room's Host controls. The list and the default are the server's (AppConfig), so a language
 * added there shows here; a language live captions cannot do yet carries a note. */

import { useId } from "react";
import {
  captionsLanguageNote,
  captionsLanguageOptions,
  captionsLanguageValue,
} from "@/lib/captions-language";
import { useAppConfig } from "./providers";

export function CaptionsLanguageSelect({
  value,
  onChange,
  disabled,
  noun = "webinar",
  label = "Captions language",
  error,
}: {
  value: string | undefined;
  onChange: (code: string) => void;
  disabled?: boolean;
  noun?: "webinar" | "meeting";
  label?: string;
  error?: string;
}) {
  const config = useAppConfig();
  const id = useId();
  const list = config.captionLanguages;
  const current = captionsLanguageValue(value, list, config.defaultCaptionsLanguage);
  const note = captionsLanguageNote(current, list, noun);
  return (
    <div className="grid gap-1">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {captionsLanguageOptions(list).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {note ? (
        <p className="text-[12px] font-medium text-warn">{note}</p>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          The language people speak in, so live captions transcribe it correctly.
        </p>
      )}
      {error && <p className="text-[12px] font-medium text-live">{error}</p>}
    </div>
  );
}
