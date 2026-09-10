/* Give a probe account the hosting capability.
 *
 * Every probe that drives a webinar needs a host, and until now each one made itself one by
 * signing up with `wantsHost: true`. That path is gone: hosting is an admin grant, because a
 * public form that hands out the ability to create webinars and collect strangers' contact
 * details is not a feature. The probes were the only honest casualty of that change.
 *
 * So they ask an admin instead, exactly as a person would. Set two variables:
 *
 *   PROBE_ADMIN_EMAIL     an account listed in the server's ADMIN_EMAILS
 *   PROBE_ADMIN_PASSWORD
 *
 * WHY THIS IS SAFE TO CALL FROM NODE while the probe's own session lives in a browser page:
 * the API re-reads the account from the database on every request, so a capability granted
 * out-of-band applies to the page's very next call. No re-login, no cookie juggling.
 *
 * Without the variables it returns a reason instead of throwing. A probe should say "I could
 * not become a host, here is why" and stop, rather than failing later with a 403 that looks
 * like a bug in the thing under test — which is precisely how this change first showed up.
 */

/**
 * Grants hosting to `email`, using admin credentials from the environment.
 *
 * Resolves to `{ ok: true }` or `{ ok: false, reason }`. Never throws for a configuration
 * problem; only genuine network failures propagate.
 */
export async function grantHost(base, email) {
  const adminEmail = process.env.PROBE_ADMIN_EMAIL;
  const adminPassword = process.env.PROBE_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    return {
      ok: false,
      reason:
        "PROBE_ADMIN_EMAIL and PROBE_ADMIN_PASSWORD are not set. Hosting is an admin grant " +
        "now, so a probe cannot create its own host. Set them to an account listed in the " +
        "server's ADMIN_EMAILS.",
    };
  }

  /* A cookie jar of one, kept by hand.
   *
   * Node's fetch does not persist cookies, and pulling in a jar library for a single
   * Set-Cookie header would add a dependency to a directory that deliberately has none. The
   * session cookie is the only one that matters, so it is read off the login response and
   * echoed back on the two calls that follow. */
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!login.ok) {
    return { ok: false, reason: `admin login failed (${login.status})` };
  }
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) return { ok: false, reason: "admin login returned no session cookie" };

  const found = await fetch(
    `${base}/api/admin/users?q=${encodeURIComponent(email)}`,
    { headers: { cookie } },
  );
  if (found.status === 403) {
    return {
      ok: false,
      reason: `${adminEmail} signed in but is not an admin — is it in the server's ADMIN_EMAILS?`,
    };
  }
  if (!found.ok) return { ok: false, reason: `admin user lookup failed (${found.status})` };

  const rows = await found.json();
  // Exact match: a search for "probe-1@x" would also return "probe-12@x", and granting
  // hosting to the wrong account is a silent, confusing failure.
  const target = rows.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!target) return { ok: false, reason: `no account found for ${email}` };

  const granted = await fetch(`${base}/api/admin/users/${target.id}/host`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ canHost: true }),
  });
  if (!granted.ok) return { ok: false, reason: `grant failed (${granted.status})` };

  return { ok: true };
}
