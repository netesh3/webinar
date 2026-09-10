import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { AppProviders } from "@/components/providers";
import { api } from "@/lib/api";
import type { AppConfig } from "@/lib/api-types";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

/** The product name comes from the API, so the tab title is generated per
 *  request rather than baked into the build. */
export async function generateMetadata(): Promise<Metadata> {
  const config = await api.config().catch(() => null);
  const name = config?.appName ?? "Webcast";
  return {
    title: `${name} — webinars, self-hosted`,
    description:
      "Browse and register for webinars, or host your own. Self-hosted on open-source infrastructure.",
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
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <AppProviders initialConfig={config}>{children}</AppProviders>
      </body>
    </html>
  );
}
