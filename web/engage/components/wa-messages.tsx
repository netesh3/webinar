import {
  NotifyWhatsAppReplay,
  type CRMMergeField,
  type CRMTemplate,
  type NotificationKind,
} from "@/lib/api-types";
import { renderTemplate } from "./crm-templates";

/* Wording helpers shared by the message pane and the rule builder.
 * The old message editor that lived here was replaced by the slot pane. */

/** What a template is for, and roughly what Meta charges for one, in words. */
export function categoryWords(category: string): string {
  const c = category.toUpperCase();
  if (c === "MARKETING") return "Promotional · ≈₹0.78";
  if (c === "UTILITY") return "Update · ≈₹0.13";
  if (c === "AUTHENTICATION") return "Code";
  return c.toLowerCase();
}

/* Guesses what fills each {{n}} from the words just before it: "Hi {{1}}" is a first
 * name, "starts {{3}}" is how soon, "…ready: {{3}}" is the link. Falls back to the usual
 * order (first name, webinar, when). Right for every starter template and most others. */
export function guessParams(
  t: CRMTemplate,
  kind: NotificationKind,
  fields: CRMMergeField[],
): string[] {
  const has = (tok: string) =>
    fields.some((f) => f.token === tok && (!f.onlyKind || f.onlyKind === kind));
  const body = t.body ?? "";
  // The replay's link is what that message is for: offered in the fallback order too.
  const order = [
    "first_name",
    "topic",
    ...(kind === NotifyWhatsAppReplay ? ["replay"] : []),
    "when",
    "host",
  ].filter(has);
  const used = new Set<string>();
  const out: string[] = [];
  const re = /\{\{\s*[^}]+\s*\}\}/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(body)) && i < t.variables) {
    const before = body.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    let tok = "";
    if (/(hi|hello|hey|dear)\s*$/.test(before)) tok = "first_name";
    else if (/(starts|starting|begins)\s*$/.test(before) && has("starts_in"))
      tok = "starts_in";
    else if (/(on|at)\s*$/.test(before) && has("when")) tok = "when";
    else if (
      /(link|here|ready|watch|recording)[:\s]*$/.test(before) &&
      has("replay") &&
      kind === NotifyWhatsAppReplay
    )
      tok = "replay";
    else if (/(of|for|joining|attending|to)\s*$/.test(before) && has("topic"))
      tok = "topic";
    if (!tok || used.has(tok))
      tok = order.find((o) => !used.has(o)) ?? order[0] ?? "first_name";
    used.add(tok);
    out.push(tok);
    i++;
  }
  while (out.length < t.variables)
    out.push(order[out.length % Math.max(1, order.length)] ?? "first_name");
  return out;
}

/** The wording with each blank shown as what fills it: "Hi [first name], …". */
export function readable(
  body: string,
  params: string[],
  fields: CRMMergeField[],
): string {
  const label = (tok: string) =>
    (fields.find((f) => f.token === tok)?.label ?? tok).toLowerCase();
  return renderTemplate(
    body,
    params.map((p) => `[${label(p)}]`),
  );
}
