/* Template names: what Meta calls a template the host writes, and how one is shown.
 *
 * A new template is named from the title the host types. The server normalises it
 * again (api/internal/engage/template_name.go). The rules are the same on both sides,
 * so the "Saved as" hint is what Meta gets. Keep the two in step; their tests share
 * cases.
 */

/** Well under Meta's 512: the name is also what a host reads in every list. */
export const TEMPLATE_NAME_MAX = 60;

/** What templates written here were called before they had names: wl_own_ and 8 hex digits. */
export const LEGACY_OWN_PREFIX = "wl_own_";

/** A title as a name Meta accepts: lowercase, spaces and hyphens to underscores,
 *  anything else outside [a-z0-9_] dropped, runs of underscores collapsed and trimmed,
 *  "t_" in front unless it starts with a letter, at most 60 characters. "" when
 *  nothing usable is left. */
export function normaliseTemplateName(title: string): string {
  let out = "";
  for (const ch of title.trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") out += ch;
    else if (ch === " " || ch === "-") out += "_";
  }
  let name = out.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) return "";
  if (!(name[0] >= "a" && name[0] <= "z")) name = `t_${name}`;
  if (name.length > TEMPLATE_NAME_MAX) name = name.slice(0, TEMPLATE_NAME_MAX).replace(/_+$/, "");
  return name;
}

/** Why the title cannot be submitted, or null. */
export function templateNameProblem(title: string): string | null {
  if (!title.trim()) return "Give the template a name.";
  if (!normaliseTemplateName(title)) return "Use at least one letter or number in the name.";
  return null;
}

/** A template name as a coach would say it: `missed_you_v2` is "Missed you". A legacy
 *  wl_own_ name loses its prefix. */
export function friendlyTemplateName(name: string): string {
  const bare = name.startsWith(LEGACY_OWN_PREFIX) ? name.slice(LEGACY_OWN_PREFIX.length) : name;
  const words = bare
    .replace(/[_-]+/g, " ")
    .replace(/\bv\d+\b/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return bare || name;
  const s = words.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The server's 409 name_taken, as the name and the next free one; null for any other
 *  error. Duck-typed on ApiError's code and fields, so this file stays dependency-free. */
export function nameTakenFrom(e: unknown): { name: string; suggestion: string } | null {
  const err = e as { code?: unknown; fields?: Record<string, string> } | null;
  if (!err || err.code !== "name_taken") return null;
  const suggestion = err.fields?.suggestion;
  const name = err.fields?.name;
  return suggestion && name ? { name, suggestion } : null;
}

/** What a template is shown as: the title the host typed, else its name made friendly. */
export function templateLabel(t: { name: string; title?: string }): string {
  return t.title?.trim() || friendlyTemplateName(t.name);
}
