/* The company's addresses at webinarliv.com, by what they are for. Every one reaches
 * the team inbox. The values come from api/types/contact.go through the generated
 * api-types.ts, so the API (Reply-To, the sales assistant) and the site never disagree.
 * Use these, not a typed-out address. (29 Oct 2026) */

import {
  ContactAbuse,
  ContactBilling,
  ContactHello,
  ContactInvite,
  ContactLegal,
  ContactPartners,
  ContactPrivacy,
  ContactSecurity,
  ContactSupport,
} from "./api-types.ts";

export const CONTACT = {
  /** Product help: accounts, webinars, the app. */
  support: ContactSupport,
  /** General enquiries and sales. */
  hello: ContactHello,
  /** Invoices, payments, refunds and GST. */
  billing: ContactBilling,
  /** Replies to invitations sent on a host's behalf. */
  invite: ContactInvite,
  /** Vulnerability reports. */
  security: ContactSecurity,
  /** Data access and deletion, DPDP/GDPR, grievances. */
  privacy: ContactPrivacy,
  /** Terms, legal notices, takedowns. */
  legal: ContactLegal,
  /** Spam or abusive webinars and hosts. */
  abuse: ContactAbuse,
  /** Affiliates, resellers and integrations. */
  partners: ContactPartners,
} as const;

export type ContactKey = keyof typeof CONTACT;

/** A mailto: link to one of the addresses, with an optional subject line. */
export function mailto(address: string, subject?: string): string {
  return subject ? `mailto:${address}?subject=${encodeURIComponent(subject)}` : `mailto:${address}`;
}

/** The addresses the /contact page lists, in order, each with what it is for. */
export const CONTACT_LIST: readonly { key: ContactKey; label: string; for: string }[] = [
  { key: "support", label: "Support", for: "help with your account, a webinar or the app" },
  { key: "hello", label: "General", for: "anything else, including questions before you buy" },
  { key: "billing", label: "Billing", for: "invoices, payments, refunds and GST" },
  { key: "partners", label: "Partners", for: "affiliates, resellers and integrations" },
  { key: "security", label: "Security", for: "reporting a vulnerability" },
  { key: "privacy", label: "Privacy", for: "access to or deletion of your data" },
];
