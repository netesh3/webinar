"use client";

import { Spinner } from "@/components/controls";
import { RotateCwIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import type { CRMMergeField, CRMTemplate } from "@/lib/api-types";

/* WhatsApp templates, as every screen that names one has to deal with them.
 *
 * Here rather than in one screen because three of them pick a template now — the
 * automatic messages, a reply in the inbox and a broadcast — and the awkward parts
 * are identical every time: a template's identity is its name AND its language, its
 * `{{n}}` have to be filled in order, and the ones Meta has not approved still have
 * to be listed so a host can see what became of the one they submitted.
 */

/** A template's identity, which is the name AND the language: the same template is
 *  approved once per translation, and a send names both. */
export function templateKey(t: CRMTemplate): string {
  return `${t.name}\u0000${t.language}`;
}

/** The body with its placeholders filled, in order — the same rule the server
 *  renders the stored copy with. A missing value leaves the placeholder visible
 *  rather than a blank, because a gap in a sentence is what the host needs to
 *  notice. */
export function renderTemplate(body: string, params: string[]): string {
  let i = 0;
  return body.replace(/\{\{\s*[^}]+\s*\}\}/g, (match) => {
    const value = params[i++] ?? "";
    return value || match;
  });
}

/** What a newly picked template starts with: the fields in the order they are
 *  offered, which for the templates hosts actually write ("Hi {{1}}, {{2}} starts
 *  {{3}}") is usually right first time. */
export function defaultTokens(
  count: number,
  fields: CRMMergeField[],
): string[] {
  if (fields.length === 0) return Array.from({ length: count }, () => "");
  return Array.from(
    { length: count },
    (_, i) => fields[Math.min(i, fields.length - 1)].token,
  );
}

/** A merge field's example value, for the preview. The token itself if it is one
 *  the server offered and we somehow have no example for — visible is better than
 *  an empty gap in a sentence. */
export function exampleFor(fields: CRMMergeField[], token: string): string {
  if (!token) return "";
  const field = fields.find((f) => f.token === token);
  return field?.example || token;
}

export function RefreshTemplates({
  syncing,
  onClick,
}: {
  syncing: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={syncing}
    >
      {syncing ? (
        <Spinner className="size-3.5" />
      ) : (
        <RotateCwIcon className="size-3.5" />
      )}
      Check WhatsApp for new templates
    </Button>
  );
}

/** Templates that exist and cannot be used, with the reason. Listed rather than
 *  hidden: a host looking for the template they submitted needs to see that it is
 *  waiting for Meta, not conclude it was lost. */
export function BlockedList({ templates }: { templates: CRMTemplate[] }) {
  return (
    <ul className="grid gap-1 text-[11.5px] text-ink-3">
      {templates.map((t) => (
        <li key={templateKey(t)}>
          <span className="font-medium">{t.name}</span> —{" "}
          {t.unsupported || `${t.status.toLowerCase()} at Meta`}
        </li>
      ))}
    </ul>
  );
}
