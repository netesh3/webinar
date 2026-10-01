"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { EmailInboxScreen } from "./email-inbox";
import { EmailTemplates } from "./email-templates";

/* Email: Inbox and Email templates, in the same tab row as WhatsApp. */

export function EmailScreen() {
  const tab = useSearchParams().get("tab") === "templates" ? "templates" : "inbox";
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [templateCount, setTemplateCount] = useState<number | null>(null);

  const tabs = [
    { id: "inbox" as const, label: "Inbox", href: "/host/email", count: inboxCount },
    {
      id: "templates" as const,
      label: "Email templates",
      href: "/host/email?tab=templates",
      count: templateCount,
    },
  ];

  return (
    <div className="grid gap-4">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Email</h1>
      <nav className="flex gap-1 border-b border-line" aria-label="Email">
        {tabs.map((item) => {
          const on = item.id === tab;
          const count = item.count != null && item.count > 0 ? item.count : null;
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={on ? "page" : undefined}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium ${
                on ? "border-brand text-brand" : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              {item.label}
              {count != null && (
                <span
                  className={`inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold ${
                    on ? "bg-brand-soft text-brand" : "bg-surface-2 text-ink-2"
                  }`}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      {tab === "inbox" ? (
        <EmailInboxScreen onCount={setInboxCount} />
      ) : (
        <EmailTemplates onCount={setTemplateCount} />
      )}
    </div>
  );
}
