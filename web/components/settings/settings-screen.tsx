"use client";

import { useEffect, useState } from "react";
import { MaterialIcon } from "../icons";
import { Spinner } from "../controls";
import { useAppConfig, useSession } from "../providers";
import { ButtonLink, Card } from "../ui";
import type { IntegrationCard } from "@/lib/api-types";
import { ApiError, api } from "@/lib/api";
import { AccountSection } from "./account-section";
import { AppearanceSection } from "./appearance-section";
import { IntegrationsSection } from "./integrations-section";
import { ProfileSection } from "./profile-section";

const SECTIONS = ["profile", "appearance", "integrations", "account"] as const;
type Section = (typeof SECTIONS)[number];

function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

/** Settings: profile, appearance, integrations, and the account itself.
 *  The tabs along the top are the only way between them. Sign out is in the
 *  account menu at the top right. */
export function SettingsScreen() {
  const { account, status } = useSession();
  const { appName } = useAppConfig();
  const [section, setSection] = useState<Section>("profile");
  const [cards, setCards] = useState<IntegrationCard[] | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);

  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (isSection(hash)) setSection(hash);
      else if (new URLSearchParams(window.location.search).has("youtube")) {
        setSection("integrations");
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  /* Integrations are a host-only read, but the cookie is enough to ask. This
   * starts with the login check. A visitor who is not a host gets nothing to
   * show — the section says so — and a failed read is not an error banner for
   * them. */
  useEffect(() => {
    let cancelled = false;
    api
      .hostIntegrations()
      .then((res) => {
        if (cancelled) return;
        setCards(res.integrations ?? []);
        setCardsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
        setCardsError(err instanceof Error ? err.message : "Could not load integrations.");
      });
    return () => {
      cancelled = true;
    };
  }, [account?.id]);

  function open(next: Section) {
    setSection(next);
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.pushState(null, "", url);
  }

  async function reloadCards() {
    const res = await api.hostIntegrations();
    setCards(res.integrations ?? []);
  }

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (!account) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">You&apos;re not signed in</h1>
        <ButtonLink href="/login?next=/settings" className="mt-5">
          Sign in
        </ButtonLink>
      </Card>
    );
  }

  const connected = (cards ?? []).filter((c) => c.status === "connected").length;
  const home = account.canHost ? "/host" : "/my-webinars";

  const items: { id: Section; label: string; icon: string }[] = [
    { id: "profile", label: "Profile", icon: "person" },
    { id: "appearance", label: "Appearance", icon: "contrast" },
    { id: "integrations", label: "Integrations", icon: "extension" },
    { id: "account", label: "Account", icon: "manage_accounts" },
  ];

  return (
    <div>
      <a href={home} className="text-[13px] text-ink-3 hover:text-ink">
        ← Your webinars
      </a>
      <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.02em]">Settings</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Your details, and the apps {appName || "Webinar Liv"} works with.
      </p>

      <nav
        className="mt-5 flex flex-wrap items-end gap-1 border-b border-line"
        aria-label="Settings"
      >
        {items.map((item) => {
          const on = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => open(item.id)}
              data-tour={`settings-${item.id}`}
              aria-current={on ? "page" : undefined}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13.5px] ${
                on
                  ? "border-brand font-medium text-brand"
                  : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              <MaterialIcon
                name={item.icon}
                className={`!text-[18px] ${on ? "text-brand" : "text-ink-3"}`}
              />
              {item.label}
              {item.id === "integrations" && connected > 0 && (
                <span className="text-[11px] font-semibold text-ok">
                  {connected} on
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-5">
          {section === "profile" && <ProfileSection account={account} />}
          {section === "appearance" && <AppearanceSection />}
          {section === "integrations" && (
            <IntegrationsSection
              canHost={account.canHost}
              cards={cards}
              error={cardsError}
              onReload={reloadCards}
            />
          )}
          {section === "account" && <AccountSection account={account} />}
      </div>
    </div>
  );
}
