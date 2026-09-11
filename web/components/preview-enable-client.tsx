"use client";

import { useEffect } from "react";
import { continueAsPreviewHost } from "@/lib/dev-bypass-session";

/** Clears bypass opt-out and navigates into the preview host session. */
export function PreviewEnableClient() {
  useEffect(() => {
    continueAsPreviewHost("/host");
  }, []);

  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center px-4 py-16 text-center">
      <p className="text-[14px] text-ink-2">Continuing as Preview Host…</p>
    </main>
  );
}
