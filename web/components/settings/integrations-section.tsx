"use client";

import { useEffect, useState } from "react";
import { Alert } from "../controls";
import { useAppConfig, useSession } from "../providers";
import { ApiError } from "@/lib/api";
import type { IntegrationCard } from "@/lib/api-types";
import { EmailIntegration } from "../email/email-inbox";
import { IntegrationCard as IntegrationCardView, SoonRow } from "./integration-card";

function youtubeReturn(result: string | null): { notice: string | null; error: string | null } {
  switch (result) {
    case "connected":
      return {
        notice: "YouTube connected. You can go live from a webinar without pasting a stream key.",
        error: null,
      };
    case "denied":
      return { notice: null, error: "YouTube access was not granted." };
    case "error":
      return {
        notice: null,
        error: "Could not connect YouTube. Try again, or paste a stream key in the room.",
      };
    default:
      return { notice: null, error: null };
  }
}

const GROUPS: { id: string; label: string }[] = [
  { id: "messaging", label: "Messaging" },
  { id: "streaming", label: "Streaming" },
];

export function IntegrationsSection({
  canHost,
  cards,
  error,
  onReload,
}: {
  canHost: boolean;
  cards: IntegrationCard[] | null;
  error: string | null;
  onReload: () => Promise<void>;
}) {
  const { refresh } = useSession();
  const { supportEmail } = useAppConfig();
  const [notice] = useState<string | null>(() =>
    typeof window === "undefined" ? null : youtubeReturn(new URLSearchParams(window.location.search).get("youtube")).notice,
  );
  const [ytError] = useState<string | null>(() =>
    typeof window === "undefined" ? null : youtubeReturn(new URLSearchParams(window.location.search).get("youtube")).error,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("youtube")) return;
    params.delete("youtube");
    params.delete("detail");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}#integrations`,
    );
    void refresh();
    void onReload();
  }, [onReload, refresh]);

  async function changed() {
    setActionError(null);
    try {
      await onReload();
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not refresh.");
    }
  }

  const list = cards ?? [];
  const soon = list.filter((c) => c.category === "soon");
  const mail = supportEmail || "support@webinarliv.com";

  return (
    <section id="integrations">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Integrations</h2>
      <p className="mt-1 max-w-xl text-[12.5px] text-ink-3">
        Connect the apps you already use. Each one is optional — you can switch it off any time.
      </p>

      {!canHost && (
        <p className="mt-4 text-[13px] text-ink-2">
          Integrations are for hosts. An administrator has to grant hosting access first.
        </p>
      )}

      {canHost && cards === null && !error && (
        <p className="mt-4 text-[13px] text-ink-3">Loading…</p>
      )}
      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {(notice || ytError || actionError) && (
        <div className="mt-4 grid gap-2">
          {notice && <Alert tone="ok">{notice}</Alert>}
          {ytError && <Alert tone="error">{ytError}</Alert>}
          {actionError && <Alert tone="error">{actionError}</Alert>}
        </div>
      )}

      {canHost &&
        GROUPS.map((group) => {
          const rows = list.filter((c) => c.category === group.id);
          if (rows.length === 0) return null;
          return (
            <div key={group.id} className="mt-5">
              <h3 className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
                {group.label}
              </h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {rows.map((card) =>
                  card.id === "email" ? (
                    <EmailIntegration
                      key={card.id}
                      address={card.who ?? ""}
                      note={card.whoNote ?? ""}
                    />
                  ) : (
                    <IntegrationCardView key={card.id} card={card} onChange={changed} />
                  ),
                )}
              </div>
            </div>
          );
        })}

      {canHost && soon.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
            Coming soon
          </h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {soon.map((card) => (
              <SoonRow key={card.id} card={card} />
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[12px] text-ink-3">
            <span>Missing an app you use?</span>
            <a className="font-medium text-brand hover:underline" href={`mailto:${mail}?subject=Integration%20request`}>
              Tell us which one
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
