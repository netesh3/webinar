import {
  FeatureJoinWithoutRegistration,
  OfferJoinWithoutRegistration,
} from "./api-types";

/** Whether this account may turn registration off for a webinar ("Join without
 *  registration", the name-only guest door).
 *
 *  Two things have to be true: the account's switch (Admin -> Accounts), and the
 *  product-wide OfferJoinWithoutRegistration, which is PAUSED (false) for now — we do not
 *  offer the option for webinars. It is generated from api/types/types.go, so the server's
 *  refusal and this hiding are one constant: set it to true there and run `make types` to
 *  bring the "Require registration" toggle, its settings row and the guest button back.
 *
 *  Meetings do not use this: they have no registration, and their door is the lobby. */
export function offersJoinWithoutRegistration(
  features: readonly string[] | null | undefined,
): boolean {
  return (
    OfferJoinWithoutRegistration &&
    (features ?? []).includes(FeatureJoinWithoutRegistration)
  );
}
