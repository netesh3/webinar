"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Spinner } from "./controls";
import { useAppConfig, useSession } from "./providers";
import { Avatar, Badge, Button, ButtonLink, Card, SectionTitle } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Account } from "@/lib/api-types";
import { YouTubeIcon } from "./icons";

/** Account settings. Deliberately small: a name, where they work, and whether
 *  this account may host. Everything else about a person lives on the
 *  registrations they make, not on a profile. */
export function AccountScreen() {
  const { account, status } = useSession();

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
        <ButtonLink href="/login?next=/account" className="mt-5">
          Sign in
        </ButtonLink>
      </Card>
    );
  }

  // Keyed by account id so the form's initial state comes from props on mount
  // rather than being copied in by an effect. Signing in as somebody else
  // remounts it with their details instead of leaving the previous person's.
  return <ProfileForm key={account.id} account={account} />;
}

function ProfileForm({ account }: { account: Account }) {
  const router = useRouter();
  const { updateProfile, signOut, refresh } = useSession();
  const { youtubeOAuth, whatsappConnect } = useAppConfig();

  const [name, setName] = useState(account.name);
  const [title, setTitle] = useState(account.title);
  const [org, setOrg] = useState(account.org);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytNotice, setYtNotice] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const result = q.get("youtube");
    if (!result) return;
    void refresh();
    if (result === "connected") {
      setYtNotice("YouTube connected. You can go live from a webinar without pasting a stream key.");
    } else if (result === "denied") {
      setError("YouTube access was not granted.");
    } else if (result === "error") {
      setError("Could not connect YouTube. Try again, or paste a stream key in the room.");
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, [refresh]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // wantsHost is no longer sent: the server ignores it and only an admin writes it.
      await updateProfile({ name, title, org });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save your changes.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="mb-6 flex items-center gap-3.5">
        <Avatar
          person={{
            id: account.id,
            name: account.name,
            title: account.title,
            org: account.org,
            initials: account.initials,
            hue: account.hue,
          }}
          size={48}
        />
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">
            {account.name}
          </h1>
          <p className="truncate text-[13px] text-ink-2">{account.email}</p>
        </div>
      </div>

      <Card className="p-5">
        <form onSubmit={save} className="grid gap-3.5">
          <SectionTitle>Your details</SectionTitle>

          <div>
            <label className="label" htmlFor="name">
              Full name
            </label>
            <input
              id="name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <p className="mt-1 text-[11.5px] text-ink-3">
              Shown to everyone in a webinar you present on.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="title">
              Job title
            </label>
            <input
              id="title"
              className="field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="org">
              Organisation
            </label>
            <input
              id="org"
              className="field"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
            />
          </div>

          {youtubeOAuth && (
            <div className="rounded-lg border border-line px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-1.5 text-[13px] font-medium">
                    <YouTubeIcon className="size-4" />
                    YouTube
                  </div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
                    {account.youtube?.connected
                      ? `Connected as ${account.youtube.channelTitle || "your channel"}. We can create Unlisted lives for you and put the watch link in Recordings.`
                      : "Connect a channel to go live without pasting a stream key. We request YouTube live-stream access only — not your Google password."}
                  </div>
                </div>
                {account.youtube?.connected ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={ytBusy}
                    onClick={async () => {
                      setYtBusy(true);
                      setError(null);
                      try {
                        await api.disconnectYouTube();
                        await refresh();
                        setYtNotice("YouTube disconnected.");
                      } catch (err) {
                        setError(
                          err instanceof ApiError
                            ? err.message
                            : "Could not disconnect YouTube.",
                        );
                      } finally {
                        setYtBusy(false);
                      }
                    }}
                  >
                    {ytBusy ? <Spinner className="size-4" /> : "Disconnect"}
                  </Button>
                ) : (
                  <a
                    href={api.youtubeConnectURL("/account")}
                    className={`${"inline-flex items-center justify-center rounded-lg bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover"} h-10`}
                  >
                    Connect
                  </a>
                )}
              </div>
            </div>
          )}

          {/* A pointer, not the card. Connecting is one of five steps and the other
              four were never here, so a host who finished this one had no way to
              learn that nothing would send yet — the checklist in the CRM lists all
              of them together. Still only for an account that may host, unlike the
              YouTube card above: the whole feature is a hosting one.

              Whether it is connected is stated here anyway, because that is the
              question somebody opens account settings to answer. */}
          {whatsappConnect && account.canHost && (
            <div className="rounded-lg border border-line px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">WhatsApp</span>
                    {account.whatsapp ? (
                      <Badge tone="ok">Connected</Badge>
                    ) : (
                      <Badge>Not connected</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {account.whatsapp?.displayPhone
                      ? `Sending from ${account.whatsapp.displayPhone}.`
                      : "Send confirmations and reminders from your own business number."}
                  </p>
                </div>
                <ButtonLink
                  href="/host/crm?view=setup"
                  size="sm"
                  variant="secondary"
                >
                  {account.whatsapp ? "Manage" : "Set up"}
                </ButtonLink>
              </div>
            </div>
          )}

          {/* Hosting is now READ-ONLY here.
              This was a Toggle wired to wantsHost, which meant any account could grant
              itself the ability to create webinars and collect strangers' names, emails
              and phone numbers. The server ignores the field now, so leaving a switch
              that appears to work would be worse than removing it. */}
          <div className="rounded-lg border border-line px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">Hosting access</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
                  {account.canHost
                    ? "You can schedule and run webinars."
                    : "Only an administrator can grant this. Ask whoever runs this instance."}
                </div>
              </div>
              <Badge tone={account.canHost ? "ok" : undefined}>
                {account.canHost ? "Granted" : "Not granted"}
              </Badge>
            </div>
          </div>

          {error && <Alert tone="error">{error}</Alert>}
          {ytNotice && <Alert tone="ok">{ytNotice}</Alert>}
          {saved && <Alert tone="ok">Saved.</Alert>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Save changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                await signOut();
                router.push("/");
              }}
            >
              Sign out
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
