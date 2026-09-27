import type { Metadata } from "next";
import { SampleSurvey, type SampleView } from "@/components/survey/sample-survey";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";

/* The post-event survey over fixture data, for design review and screenshots, like
 * /mock/engagement: ?view=popup | link | thanks | setup | setup-link | results. */

export const metadata: Metadata = {
  title: "Survey (sample)",
  robots: { index: false, follow: false },
};

const VIEWS: readonly SampleView[] = ["popup", "link", "thanks", "setup", "setup-link", "results"];

export default async function SurveyMockPage({ searchParams }: PageProps<"/mock/survey">) {
  const raw = (await searchParams).view;
  const view = VIEWS.find((v) => v === raw) ?? "popup";
  return <SampleSurvey view={view} webinar={DEV_BYPASS_WEBINARS[0]} />;
}
