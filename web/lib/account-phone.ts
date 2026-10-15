/** True when a signed-in account still needs a typed mobile number.
 *
 * Google's People number lives on googlePhone and does not count: hosts
 * need the number the person entered, and registration requires that one.
 */
export function needsManualPhone(account: {
  phone?: string;
  googlePhone?: string;
} | null): boolean {
  return !!account && !account.phone?.trim();
}
