import type { Metadata, Viewport } from "next";
import { Fraunces, Geist, Outfit } from "next/font/google";
import Script from "next/script";
import { AppProviders } from "@/components/providers";
import { PhonePrompt } from "@/components/phone-prompt";
import { api } from "@/lib/api";
import { siteOrigin } from "@/lib/site-origin";
import type { AppConfig } from "@/lib/api-types";
import { SidebarBoot } from "@/components/sidebar-boot";
import { PwaBoot } from "@/components/pwa";
import { FaroBoot } from "@/components/faro-boot";
import { sidebarBootScript } from "@/lib/sidebar";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";
import "./sidebar.css";

const GA_MEASUREMENT_ID = "G-C79Q63GQLN";
const GTM_CONTAINER_ID = "GTM-MNTKG425";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

/** Marketing homepage display — expressive, not the portal UI stack. */
const homeDisplay = Fraunces({
  variable: "--font-home-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const homeSans = Outfit({
  variable: "--font-home-sans",
  subsets: ["latin"],
});

/** The product name comes from the API, so the tab title is generated per
 *  request rather than baked into the build. */
export async function generateMetadata(): Promise<Metadata> {
  const config = await api.config().catch(() => null);
  const name = config?.appName ?? "Webinar Liv";
  const title = `${name} — host webinars, self-hosted`;
  const description =
    "Schedule and host webinars with chat, Q&A, polls, screen share, and admit controls. Self-hosted on open-source infrastructure.";
  return {
    // Resolves each page's canonical URL, so www and apex are not indexed twice.
    metadataBase: new URL(await siteOrigin()),
    title,
    description,
    applicationName: name,
    /* Added to the Home Screen on iPhone and iPad it opens standalone, which is also the
     * only way iOS (16.4+) delivers Web Push. The icon is app/apple-icon.png. */
    appleWebApp: {
      capable: true,
      title: name,
      statusBarStyle: "default",
    },
    // Google Search Console / Auth Platform homepage ownership verification
    verification: {
      google: "xjAAcbLTS2AMiLjfZuvIt8FZ8UUMaxRzlll7U9_3lQE",
    },
    openGraph: {
      title,
      description,
      siteName: name,
      type: "website",
    },
  };
}

/** The installed app's title bar, and the mobile browser's: --color-brand. */
export const viewport: Viewport = {
  themeColor: "#0b5cff",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Fetched here so the shell renders with the operator's branding on the first
  // paint instead of flashing a placeholder. A failure is not fatal: the provider
  // falls back and retries on the client.
  let config: AppConfig | null = null;
  try {
    config = await api.config();
  } catch {
    config = null;
  }

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${homeDisplay.variable} ${homeSans.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Before paint: stored choice, otherwise prefers-color-scheme. Light
            when neither says dark. suppressHydrationWarning is on <html>
            because this sets data-theme ahead of React. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
        {/* Before paint: collapsed rail when that choice was saved, or when the
            window is under 1280px. suppressHydrationWarning is already on <html>. */}
        <script dangerouslySetInnerHTML={{ __html: sidebarBootScript() }} />
        {/* Google Material Symbols */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
        {/* Google tag (gtag.js) — GA4 property */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_MEASUREMENT_ID}');`}
        </Script>
        {/* Google Tag Manager */}
        <Script id="gtm" strategy="afterInteractive">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','${GTM_CONTAINER_ID}');`}
        </Script>
      </head>
      <body className="flex min-h-full flex-col font-sans">
        <SidebarBoot />
        {/* The service worker (push, offline page) and the install prompt. Asks for nothing. */}
        <PwaBoot />
        {/* Grafana Faro (errors, Web Vitals), loaded after the page; off without NEXT_PUBLIC_FARO_URL. */}
        <FaroBoot />
        {/* Google Tag Manager (noscript) */}
        <noscript>
          <iframe
            src={`https://www.googletagmanager.com/ns.html?id=${GTM_CONTAINER_ID}`}
            height="0"
            width="0"
            style={{ display: "none", visibility: "hidden" }}
            title="Google Tag Manager"
          />
        </noscript>
        <AppProviders initialConfig={config}>
          {children}
          <PhonePrompt />
        </AppProviders>
      </body>
    </html>
  );
}
