"use client";

import { useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { useAppConfig, useAppConfigStatus } from "@/components/providers";
import { Card } from "@/components/ui";
import { DRIVE_PICKED_LINK } from "@/lib/app-connect";
import { chooseFromDrive, driveConfigured } from "@/lib/drive";

/**
 * "Pick from Drive" for a room in the desktop or mobile app, in the SYSTEM browser
 * (29 Oct 2026; lib/app-connect.ts).
 *
 * Google's sign-in and Picker refuse the app's webview, so the room sent this browser here
 * through /api/integrations/drive/app-start, which spent the room's one-time ticket and set a
 * pick cookie. Here they run with the person's own Google session. The chosen file and the
 * short read-only token go to the API for that room alone, and webinarliv://connect/picked
 * brings the app back to the front, where the room is waiting for them. Nothing is signed in
 * here, and nothing else is shared.
 */
type Step =
  | { at: "ready" }
  | { at: "busy"; label: string }
  | { at: "done" }
  | { at: "error"; message: string };

export default function DrivePickPage() {
  const { googleClientId, googleApiKey } = useAppConfig();
  const configStatus = useAppConfigStatus();
  const config = { clientId: googleClientId ?? "", apiKey: googleApiKey ?? "" };
  const [step, setStep] = useState<Step>({ at: "ready" });

  const choose = async () => {
    if (!driveConfigured(config)) return;
    setStep({ at: "busy", label: "Waiting for Google…" });
    try {
      const chosen = await chooseFromDrive(config);
      if (!chosen) {
        setStep({ at: "ready" });
        return;
      }
      setStep({ at: "busy", label: "Sending it to the app…" });
      const res = await fetch(`${window.location.origin}/api/integrations/drive/app-pick`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: chosen.file.id,
          name: chosen.file.name,
          size: chosen.file.size,
          mimeType: chosen.file.mimeType,
          accessToken: chosen.token,
        }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setStep({ at: "error", message: body?.message || "That file couldn't be sent to the app. Start again from the app." });
        return;
      }
      setStep({ at: "done" });
      window.location.assign(DRIVE_PICKED_LINK);
    } catch (err) {
      setStep({ at: "error", message: err instanceof Error ? err.message : "Couldn't reach Google Drive." });
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-16 sm:px-5">
      <Card className="mx-auto w-full max-w-sm p-6 text-center">
        {step.at === "done" ? (
          <>
            <h1 className="text-[18px] font-semibold">Video chosen</h1>
            <p className="mt-2 text-[13px] text-ink-2">
              Go back to the Webinar Liv app. It is copying the video into your room.
            </p>
            <a
              href={DRIVE_PICKED_LINK}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-brand px-4 text-[14px] font-medium text-white"
            >
              Open Webinar Liv
            </a>
          </>
        ) : (
          <>
            <h1 className="text-[18px] font-semibold">Choose a video from Google Drive</h1>
            <p className="mt-2 text-[13px] text-ink-2">
              For the room open in the Webinar Liv app. Read-only, and only the file you choose is
              sent to it.
            </p>
            {step.at === "error" && (
              <div className="mt-3 text-left">
                <Alert tone="error">{step.message}</Alert>
              </div>
            )}
            {configStatus === "loading" ? (
              <Spinner className="mx-auto mt-4 size-5" />
            ) : !driveConfigured(config) ? (
              <p className="mt-4 text-[12px] text-ink-3">Google Drive isn&rsquo;t set up on this instance.</p>
            ) : step.at === "busy" ? (
              <div className="mt-4 flex items-center justify-center gap-2 text-[13px] text-ink-2">
                <Spinner className="size-4" />
                {step.label}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void choose()}
                className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-brand px-4 text-[14px] font-medium text-white"
              >
                Choose from Drive
              </button>
            )}
            <a href={DRIVE_PICKED_LINK} className="mt-4 block text-[12px] text-ink-3 hover:underline">
              Back to the app
            </a>
          </>
        )}
      </Card>
    </main>
  );
}
