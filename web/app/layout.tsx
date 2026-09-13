import type { Metadata } from "next";
import { Fraunces, Geist, Outfit } from "next/font/google";
import Script from "next/script";
import { AppProviders } from "@/components/providers";
import { api } from "@/lib/api";
import type { AppConfig } from "@/lib/api-types";
import "./globals.css";

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
    title,
    description,
    applicationName: name,
    openGraph: {
      title,
      description,
      siteName: name,
      type: "website",
    },
  };
}

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
    >
      <head>
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
        <AppProviders initialConfig={config}>{children}</AppProviders>
      </body>
    </html>
  );
}
