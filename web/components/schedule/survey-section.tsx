"use client";

import type { ReactNode } from "react";
import { FormGroup, FormSection } from "./chrome";

export function SurveySection({ survey }: { survey: ReactNode }) {
  return (
    <FormGroup label="Feedback">
      <FormSection
        title="Feedback survey"
        description="Set it up now; in the room it's one button. Results land on the webinar's page afterwards."
        first
      >
        {survey}
      </FormSection>
    </FormGroup>
  );
}
