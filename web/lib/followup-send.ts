/* Sending the AI follow-ups, the pure half: which channel each person starts on in the
 * review screen (WhatsApp when it can reach them, else email), the words for every reason
 * a channel is off, the chunks a long list is sent in, and the WhatsApp template preview,
 * which mirrors the server's (api/internal/engage/followup_send.go) so the host reads what
 * the person will.
 *
 * No imports but types, so node runs the tests as they are:
 *   node --experimental-strip-types --no-warnings lib/followup-send.test.mts */
import type { FollowupChannelPlan, FollowupRecipient, FollowupSendItem, FollowupSendResult } from "./api-types";

export type FollowupChannel = "email" | "whatsapp";
/** What the host asked for: a per-lead button names a channel; "auto" is WhatsApp, else email. */
export type ChannelPref = FollowupChannel | "auto";

/** One row of the review screen, as the host edits it. */
export type ReviewRow = {
  recipient: FollowupRecipient;
  /** null when neither channel can reach them: the row is shown, and not sent. */
  channel: FollowupChannel | null;
  /** WhatsApp was asked for and email is used instead. */
  fallback: boolean;
  subject: string;
  body: string;
  whatsapp: string;
};

export function planFor(r: FollowupRecipient, channel: FollowupChannel): FollowupChannelPlan {
  return channel === "email" ? r.emailPlan : r.whatsappPlan;
}

/** The channel a person starts on, and whether it is the email fallback. */
export function pickChannel(r: FollowupRecipient, pref: ChannelPref): { channel: FollowupChannel | null; fallback: boolean } {
  if (pref === "email") return { channel: r.emailPlan.available ? "email" : null, fallback: false };
  if (r.whatsappPlan.available) return { channel: "whatsapp", fallback: false };
  if (r.emailPlan.available) return { channel: "email", fallback: true };
  return { channel: null, fallback: false };
}

export function reviewRows(recipients: readonly FollowupRecipient[], pref: ChannelPref): ReviewRow[] {
  return recipients.map((r) => ({
    recipient: r,
    ...pickChannel(r, pref),
    subject: r.subject,
    body: r.body,
    whatsapp: r.whatsappText,
  }));
}

/** What one row sends, or null when it sends nothing. */
export function rowItem(row: ReviewRow): FollowupSendItem | null {
  if (!row.channel) return null;
  if (row.channel === "email") {
    return { key: row.recipient.key, channel: "email", subject: row.subject.trim(), body: row.body.trim() };
  }
  return { key: row.recipient.key, channel: "whatsapp", body: row.whatsapp.trim() };
}

/** Whether a row on its channel has already had this follow-up (sending needs "send again"). */
export function alreadySent(row: ReviewRow): boolean {
  return row.channel ? Boolean(planFor(row.recipient, row.channel).sent) : false;
}

export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Why a channel cannot reach somebody, or why a send was skipped or failed. */
export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case "already_sent":
      return "Already sent this follow-up";
    case "in_progress":
      return "Being sent right now";
    case "unsubscribed":
      return "Unsubscribed from your emails";
    case "no_email":
      return "No email address";
    case "mail_unconfigured":
      return "Email isn't set up on this server";
    case "whatsapp_not_connected":
      return "WhatsApp isn't connected";
    case "whatsapp_plan":
      return "WhatsApp is on Professional and up";
    case "no_contact":
      return "Not in your WhatsApp contacts";
    case "no_number":
      return "No WhatsApp number";
    case "opted_out":
      return "Opted out of WhatsApp";
    case "no_opt_in":
      return "Didn't opt in to WhatsApp";
    case "template_not_approved":
      return "Outside the 24-hour window and the follow-up template isn't approved yet";
    case "not_in_session":
      return "Not in this session";
    case "empty":
      return "The message is empty";
    case "too_long":
      return "The message is too long";
    case "bad_channel":
      return "Unknown channel";
    case "rate_limited":
      return "Hourly limit reached";
    case "send_failed":
      return "Couldn't be sent";
  }
  return reason ? "Not sent" : "";
}

/** One result in words, for the row it belongs to. */
export function resultText(r: FollowupSendResult): string {
  if (r.status === "sent") {
    if (r.channel === "email") return "Email sent";
    return r.mode === "template" ? "WhatsApp sent (template)" : "WhatsApp sent";
  }
  const why = r.error || reasonText(r.reason);
  return r.status === "skipped" ? `Skipped: ${why}` : `Failed: ${why}`;
}

export function summarize(results: readonly FollowupSendResult[]): { sent: number; failed: number; skipped: number } {
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    if (r.status === "sent") out.sent++;
    else if (r.status === "failed") out.failed++;
    else out.skipped++;
  }
  return out;
}

/** The follow-up template's status in words; sendable only when Meta approved it. */
export function templateStatusText(status: string | undefined): { label: string; tone: "ok" | "warn" | "neutral" | "live"; approved: boolean } {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
      return { label: "Approved", tone: "ok", approved: true };
    case "PENDING":
    case "IN_APPEAL":
      return { label: "Waiting for Meta", tone: "warn", approved: false };
    case "REJECTED":
      return { label: "Rejected by Meta", tone: "live", approved: false };
    case "PAUSED":
    case "DISABLED":
      return { label: "Paused by Meta", tone: "live", approved: false };
    case "":
      return { label: "Not submitted", tone: "neutral", approved: false };
  }
  return { label: status ?? "", tone: "neutral", approved: false };
}

// The server's template wording, kept in step with FollowupTemplateBody.
export const FOLLOWUP_TEMPLATE_BODY =
  "Hi {{1}}, a quick note about {{2}}:\n\n{{3}}\n\nJust reply here if you have any questions.";
const TEMPLATE_BODY_MAX = 1024;
const leadingGreeting = /^\s*(hi|hello|hey|hii|namaste|dear)\b[^,\n!.]{0,40}[,!.]?\s*/i;

/** Text made fit for a template variable: no newline, tab or run of spaces; clipped. */
export function templateVariable(text: string, max: number): string {
  let s = text.replace(/\s+/g, " ").trim();
  const runes = Array.from(s);
  if (max > 0 && runes.length > max) s = runes.slice(0, Math.max(0, max - 1)).join("").trim() + "…";
  return s;
}

/** The three values the template is sent with, as the server fills them. */
export function templateParams(firstName: string, topic: string, text: string): [string, string, string] {
  const name = templateVariable(firstName, 40) || "there";
  const t = templateVariable(topic, 120) || "the session";
  let msg = text.trim();
  const m = leadingGreeting.exec(msg);
  if (m && m[0].length < msg.length) msg = msg.slice(m[0].length);
  const fixed = Array.from(FOLLOWUP_TEMPLATE_BODY).length - "{{1}}{{2}}{{3}}".length;
  const room = TEMPLATE_BODY_MAX - fixed - Array.from(name).length - Array.from(t).length;
  return [name, t, templateVariable(msg, room)];
}

/** What the person reads on WhatsApp: the text itself inside the window, else the template. */
export function whatsappPreview(mode: string | undefined, firstName: string, topic: string, text: string): string {
  if (mode !== "template") return text.trim();
  const p = templateParams(firstName, topic, text);
  return FOLLOWUP_TEMPLATE_BODY.replace("{{1}}", p[0]).replace("{{2}}", p[1]).replace("{{3}}", p[2]);
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
