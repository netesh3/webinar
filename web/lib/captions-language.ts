/* The webinar's captions language (api/types/captions_language.go): which one the select
 * shows, and the note under it for a language live captions cannot do yet. The list itself
 * comes from the server (AppConfig.captionLanguages); FALLBACK_CAPTION_LANGUAGES is only for
 * the moment before the config arrives. */

import type { CaptionLanguage } from "./api-types.ts";

export const DEFAULT_CAPTIONS_LANGUAGE = "en-IN";

export const FALLBACK_CAPTION_LANGUAGES: CaptionLanguage[] = [
  { code: DEFAULT_CAPTIONS_LANGUAGE, label: "English (India)", live: true },
];

/** The code the select shows: the chosen one when it is on the list, else the server default,
 *  else English (India). A webinar from before the setting has none. */
export function captionsLanguageValue(
  chosen: string | undefined,
  list: readonly CaptionLanguage[],
  serverDefault: string | undefined,
): string {
  const known = (code: string | undefined) =>
    !!code && list.some((l) => l.code === code);
  if (known(chosen)) return chosen as string;
  if (known(serverDefault)) return serverDefault as string;
  return DEFAULT_CAPTIONS_LANGUAGE;
}

/** The note for a language live captions cannot do yet (Malayalam), null otherwise. */
export function captionsLanguageNote(
  code: string,
  list: readonly CaptionLanguage[],
  noun: "webinar" | "meeting" = "webinar",
): string | null {
  const l = list.find((x) => x.code === code);
  if (!l || l.live) return null;
  return `${l.label} captions are coming soon; captions will be off for this ${noun}.`;
}

/** The select's options, a language that is not live yet marked as such. */
export function captionsLanguageOptions(
  list: readonly CaptionLanguage[],
): { value: string; label: string }[] {
  return list.map((l) => ({
    value: l.code,
    label: l.live ? l.label : `${l.label} (coming soon)`,
  }));
}
