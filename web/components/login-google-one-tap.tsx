"use client";

import { useSearchParams } from "next/navigation";
import { GoogleOneTap } from "@/components/google-one-tap";
import { safeAuthNext } from "@/lib/supabase";

/** One Tap on /login that respects ?next= (same as the password form). */
export function LoginGoogleOneTap() {
  const params = useSearchParams();
  const next = safeAuthNext(params.get("next"), "/browse");
  return <GoogleOneTap next={next} />;
}
