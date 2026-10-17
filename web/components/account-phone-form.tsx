"use client";

import { useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { DIAL_CODES, dialOptions, nationalPhoneDigits } from "@/lib/dial-codes";
import { useSession } from "./providers";
import { Alert, Spinner } from "./controls";
import { Button } from "./ui";

/** Typed account phone, saved through PATCH /api/auth/me.
 *
 * Google's People number is not written here. Empty is allowed on the
 * profile form; the in-app prompt requires a number. */
export function AccountPhoneForm({
  initialPhone,
  googlePhone,
  required,
  submitLabel = "Save number",
}: {
  initialPhone: string;
  googlePhone?: string;
  required?: boolean;
  submitLabel?: string;
}) {
  const { updateProfile } = useSession();
  const [dialIso, setDialIso] = useState("IN");
  const [phoneNumber, setPhoneNumber] = useState(() =>
    nationalPhoneDigits(initialPhone),
  );
  const dials = useMemo(() => dialOptions(), []);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const digits = phoneNumber.replace(/\D/g, "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setField(null);
    setSaved(false);
    if (required && !digits) {
      setField("Add a mobile number.");
      return;
    }
    if (digits && digits.length < 8) {
      setField("That number looks too short — include the country code.");
      return;
    }
    setBusy(true);
    try {
      const phone = digits ? `+${DIAL_CODES[dialIso] ?? ""}${digits}` : "";
      // The one place the account phone is saved. A WhatsApp OTP check goes here.
      await updateProfile({ phone });
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.fields?.phone) {
        setField(err.fields.phone);
      } else {
        setError(
          err instanceof ApiError ? err.message : "Could not save that number.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-2">
      <label className="label" htmlFor="account-phone">
        Mobile number
        {!required && <span className="text-ink-3"> (optional)</span>}
      </label>
      <div className="flex gap-2">
        <select
          aria-label="Country calling code"
          className="field w-32 shrink-0"
          value={dialIso}
          onChange={(e) => setDialIso(e.target.value)}
        >
          {dials.map((d) => (
            <option key={d.iso} value={d.iso}>
              {d.label}
            </option>
          ))}
        </select>
        <input
          id="account-phone"
          className={`field min-w-0 flex-1 ${field ? "border-live" : ""}`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          value={phoneNumber}
          onChange={(e) =>
            setPhoneNumber(e.target.value.replace(/\D/g, "").slice(0, 15))
          }
          aria-invalid={Boolean(field)}
        />
      </div>
      {field && (
        <p className="text-[12px] font-medium text-live">{field}</p>
      )}
      {googlePhone?.trim() && (
        <p className="text-[12px] leading-relaxed text-ink-3">
          Google also has {googlePhone} on this account. That number is kept
          separately and is not replaced by what you type here.
        </p>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="ok">Saved.</Alert>}
      <div>
        <Button type="submit" disabled={busy} size="sm">
          {busy && <Spinner className="size-4" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
