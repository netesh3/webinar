/* Rendering a chat message safely.
 *
 * Everything here arrives from another participant, so the question is not "how do we
 * make links clickable" but "what is the smallest thing we can do that is still useful".
 * The answer is: split the text into plain runs and link runs, and let React render both
 * as text nodes and anchors. No HTML is ever constructed, so there is no sanitiser to
 * get wrong and no dangerouslySetInnerHTML to audit.
 *
 * Basic emphasis is deliberately NOT supported. Somebody typing *asterisks* means
 * asterisks far more often than they mean bold, and a formatter that guesses wrong
 * silently eats characters out of what was said. Emoji need nothing — they are text.
 */

export type TextRun = { text: string } | { text: string; href: string };

/** Matches a bare URL or a www. host. Deliberately conservative: a greedy pattern
 *  swallows trailing punctuation and turns "see http://x." into a link to "x." */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Trailing characters that are almost always sentence punctuation rather than part of
 *  the address. Brackets are balanced rather than stripped, because a Wikipedia URL
 *  really does end in one. */
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Splits a message into text and links.
 *
 * Only http and https survive as links. `javascript:`, `data:` and every other scheme
 * is left as plain text — a chat message is the last place a scheme should be trusted,
 * and the pattern above cannot match them anyway. The check is repeated on the parsed
 * result because "the regex cannot produce one" is exactly the assumption that stops
 * being true when someone widens the pattern.
 */
export function textRuns(input: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;

  for (const match of input.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let raw = match[0];

    // Unbalanced closing bracket at the end belongs to the sentence, not the URL.
    if (raw.endsWith(")") && count(raw, "(") < count(raw, ")")) raw = raw.slice(0, -1);
    raw = raw.replace(TRAILING, "");
    if (!raw) continue;

    if (start > last) runs.push({ text: input.slice(last, start) });

    const href = raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw;
    if (isSafeHref(href)) {
      runs.push({ text: raw, href });
    } else {
      runs.push({ text: raw });
    }
    last = start + raw.length;
  }

  if (last < input.length) runs.push({ text: input.slice(last) });
  return runs.length > 0 ? runs : [{ text: input }];
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** http and https only, parsed rather than pattern-matched: URL() resolves the escapes
 *  and unicode tricks a substring check would miss. */
function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
