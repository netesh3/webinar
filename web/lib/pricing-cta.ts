/* What a plan card on the pricing page offers.
 *
 *   contact  a plan sold by talking to us (Enterprise): no price, no buy, no trial
 *   trial    the 7-day free trial: monthly, in the trial currency, when trials are on
 *   buy      pay now: yearly, another currency, or trials switched off
 *
 * The server refuses the same combinations (POST /api/billing/trial and
 * /api/billing/orders), so this only decides what the button says. */

export type PlanCta = "contact" | "trial" | "buy";

export function planCta(
  plan: { contactOnly?: boolean },
  period: string,
  currency: string,
  catalogue: { trialDays: number; trialCurrency?: string } | null,
): PlanCta {
  if (plan.contactOnly) return "contact";
  if (
    catalogue &&
    catalogue.trialDays > 0 &&
    period === "monthly" &&
    currency === catalogue.trialCurrency
  ) {
    return "trial";
  }
  return "buy";
}
