"use client";

import type { ReactNode } from "react";
import { FormGroup, FormSection } from "./chrome";

export function SurveySection({
  survey,
  polls,
  previews,
}: {
  survey: ReactNode;
  polls: ReactNode;
  /** Sticky column: survey + one poll + one quiz preview. */
  previews?: ReactNode;
}) {
  return (
    <FormGroup label="Feedback">
      <div
        className={
          previews
            ? "grid items-start xl:grid-cols-[minmax(0,1fr)_17.5rem]"
            : undefined
        }
      >
        <div className="min-w-0">
          <FormSection
            title="Feedback survey"
            description="Set it up now; in the room it's one button. Results land on the webinar's page afterwards."
            first
          >
            {survey}
          </FormSection>
          <FormSection
            title="Live polls"
            description="Prepare now. During the webinar you'll only tap Launch — no typing mid-session."
          >
            {polls}
          </FormSection>
        </div>
        {previews && (
          <aside className="hidden border-l border-line px-3 py-5 xl:block">
            <div className="xl:sticky xl:top-4 grid gap-4">{previews}</div>
          </aside>
        )}
      </div>
    </FormGroup>
  );
}
