"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  IOS_SOON,
  anyReady,
  arrangeOffers,
  detectPlatform,
  formatSize,
  macArchFromHint,
  orderMacLinks,
  type DownloadLink,
  type PlatformId,
  type PlatformOffer,
  type VisitorPlatform,
} from "@/lib/downloads";
import { ArrowRight } from "./plans-ui";
import "@/app/landing.css";
import "@/app/plans.css";
import "@/app/download.css";

/* /download: the visitor's own platform first, the rest under "Other platforms". What is
 * on offer comes from the release manifest (lib/downloads.ts decides, the page draws).
 *
 * The server picks the platform from the user agent; the client refines it once hydrated:
 * iPadOS Safari calls itself a Mac (maxTouchPoints gives it away), and Chromium on a Mac
 * says whether it is Apple Silicon or Intel. Safari and Firefox do not, so a Mac visitor
 * there gets both builds side by side. */

const noSubscribe = () => () => {};

/** The visitor's platform when its app is not on offer yet (iOS always is, as "soon"). */
const SOON_NAME: Partial<Record<VisitorPlatform, string>> = { mac: "Mac", windows: "Windows", android: "Android" };

type UADataNavigator = Navigator & {
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
};

function useMacArch(enabled: boolean): "mac-arm64" | "mac-x64" | null {
  const [arch, setArch] = useState<"mac-arm64" | "mac-x64" | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const get = (navigator as UADataNavigator).userAgentData?.getHighEntropyValues;
    if (!get) return;
    let live = true;
    get
      .call((navigator as UADataNavigator).userAgentData, ["architecture"])
      .then((v) => {
        if (live) setArch(macArchFromHint(v.architecture));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return arch;
}

export function DownloadChooser({
  offers,
  serverPlatform,
}: {
  offers: PlatformOffer[];
  serverPlatform: VisitorPlatform;
}) {
  const platform = useSyncExternalStore(
    noSubscribe,
    () => detectPlatform(navigator.userAgent, navigator.maxTouchPoints || 0),
    () => serverPlatform,
  );
  const ready = anyReady(offers);
  const { primary, others } = arrangeOffers(offers, platform);
  const arch = useMacArch(primary?.id === "mac");

  return (
    <>
      <section className="hero hero-dark pl-hero dl-hero" aria-labelledby="download-title">
        <div className="hero-bg" aria-hidden />
        <div className="wrap">
          <div className="hero-copy">
            <p className="eyebrow pl-hero-eyebrow">Apps</p>
            <h1 id="download-title" className="h1">
              Get the <em className="grad-text">Webinar Liv</em> app
            </h1>
            <p className="hero-lede">
              Host and join from an app on your computer or phone, with your webinars a click away. Everything
              also works in any browser, with nothing to install.
            </p>
          </div>

          {!ready ? (
            <div className="dl-empty">
              <p>
                <b>Apps are coming soon.</b> Webinar Liv works in any browser today.
              </p>
              <div className="cta-row">
                <Link className="btn btn-white btn-lg" href="/login">
                  Sign in <ArrowRight />
                </Link>
                <Link className="btn btn-outline-light btn-lg" href="/signup">
                  Create an account
                </Link>
              </div>
            </div>
          ) : primary ? (
            <PlatformCard offer={primary} arch={arch} primary />
          ) : (
            <p className="dl-pick">
              {SOON_NAME[platform] ? `The ${SOON_NAME[platform]} app is on its way. ` : ""}
              Choose a platform below, or keep using Webinar Liv in your browser.
            </p>
          )}
        </div>
      </section>

      {ready && others.length > 0 && (
        <section className="section dl-others" aria-labelledby="download-others">
          <div className="wrap">
            <h2 id="download-others" className="dl-others-title">
              {primary ? "Other platforms" : "Available for"}
            </h2>
            <ul className="dl-grid">
              {others.map((o) => (
                <li key={o.id}>
                  <PlatformCard offer={o} arch={null} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}

function PlatformCard({
  offer,
  arch,
  primary = false,
}: {
  offer: PlatformOffer;
  arch: "mac-arm64" | "mac-x64" | null;
  primary?: boolean;
}) {
  const links = offer.id === "mac" ? orderMacLinks(offer.links, arch) : offer.links;
  // On the visitor's own Mac with a known chip, one big button and the other build small.
  const lead = primary && offer.id === "mac" && arch && links.length > 1 ? 1 : links.length;
  const files = links.filter((l): l is Extract<DownloadLink, { kind: "file" }> => l.kind === "file");
  const version = files[0]?.version;

  return (
    <article className={primary ? "dl-card dl-card-primary" : "dl-card"} aria-label={offer.name}>
      <header className="dl-card-head">
        <span className="dl-icon" aria-hidden>
          <PlatformIcon id={offer.id} />
        </span>
        <span>
          {primary && <span className="dl-card-kicker">For your device</span>}
          <h3 className="dl-card-title">{offer.name}</h3>
          {version && <span className="dl-card-meta">Version {version}</span>}
        </span>
      </header>

      {offer.status === "soon" ? (
        <p className="dl-soon">
          {IOS_SOON}. Until then, Webinar Liv works in Safari on your iPhone and iPad.
        </p>
      ) : (
        <div className="dl-actions">
          {links.slice(0, lead).map((l) => (
            <LinkButton key={l.id} link={l} offer={offer.id} big={primary} />
          ))}
          {links.slice(lead).map((l) => (
            <a key={l.id} className="dl-alt" href={l.url}>
              Download for {l.label} instead
            </a>
          ))}
        </div>
      )}

      {offer.id === "mac" && !arch && links.length > 1 && (
        <p className="dl-note">Not sure which? Apple menu → About This Mac: “Chip Apple M…” is Apple Silicon.</p>
      )}
      {offer.notes.map((n) => (
        <p key={n} className="dl-note">
          {n}
        </p>
      ))}

      {files.length > 0 && (
        <details className="dl-verify">
          <summary>Verify download</summary>
          <dl>
            {files.map((f) => (
              <div key={f.id} className="dl-verify-row">
                <dt>{f.label}</dt>
                <dd>
                  Version {f.version} · {formatSize(f.size)}
                </dd>
                <dd>
                  SHA-256 <code>{f.sha256}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}

function LinkButton({ link, offer, big }: { link: DownloadLink; offer: PlatformId; big: boolean }) {
  const text: ReactNode =
    link.kind === "file" && offer === "mac" ? `Download for ${link.label}` : link.label;
  const cls = `btn ${big ? "btn-primary btn-lg" : "btn-ghost btn-sm"} dl-btn`;
  const external = link.kind === "store" ? { target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <a className={cls} href={link.url} {...external}>
      {link.kind === "file" ? <DownloadGlyph /> : null}
      <span>{text}</span>
      {link.kind === "file" && <span className="dl-size">{formatSize(link.size)}</span>}
    </a>
  );
}

function DownloadGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

/** Simple device marks, not the platform owners' artwork. */
function PlatformIcon({ id }: { id: PlatformId }) {
  switch (id) {
    case "mac":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M2 19h20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "windows":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path fill="currentColor" d="M3 5.5 10.5 4.4v7H3zM11.5 4.3 21 3v8.4h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z" />
        </svg>
      );
    case "android":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path fill="currentColor" d="M4 17a8 8 0 0 1 16 0z" />
          <path d="M7.5 7.5 6 5M16.5 7.5 18 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="9" cy="13.3" r="1" fill="var(--surface)" />
          <circle cx="15" cy="13.3" r="1" fill="var(--surface)" />
        </svg>
      );
    case "ios":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}
