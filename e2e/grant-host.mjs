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
 * Resolves to `{ ok: true, id, cookie }` (the account's id and the admin's session cookie) or
 * `{ ok: false, reason }`. Never throws for a configuration problem; only genuine network
 * failures propagate. `features` are per-account feature keys to switch on as well (e.g.
 * "instant_webinar"). A .invalid address is verified on the way (see below).
 */
export async function grantHost(base, email, { features = [] } = {}) {
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

  /* Password signup leaves the address unverified, and an unverified account cannot sign in.
   * A probe's address is a .invalid one that never gets the link, so the admin verifies it
   * (POST /api/admin/users/{id}/verify-email, which only accepts .invalid addresses). A server
   * from before that endpoint answers 404/405; the probe then fails at its login, as before. */
  if (target.email.toLowerCase().endsWith(".invalid")) {
    const verified = await fetch(`${base}/api/admin/users/${target.id}/verify-email`, {
      method: "POST",
      headers: { cookie },
    });
    if (!verified.ok && verified.status !== 404 && verified.status !== 405) {
      return { ok: false, reason: `verify failed (${verified.status})` };
    }
  }

  const granted = await fetch(`${base}/api/admin/users/${target.id}/host`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ canHost: true }),
  });
  if (!granted.ok) return { ok: false, reason: `grant failed (${granted.status})` };

  // Optional per-account features, e.g. instant_webinar so a probe can start right away.
  for (const feature of features) {
    const f = await fetch(`${base}/api/admin/users/${target.id}/features`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ feature, enabled: true }),
    });
    if (!f.ok) return { ok: false, reason: `grant ${feature} failed (${f.status})` };
  }

  return { ok: true, id: target.id, cookie };
}
