/* Customers and webinar audience, told apart.
 *
 * Registering for somebody's webinar creates an account (store.ensureAttendee), so
 * the admin list mixed the people who signed up for Webinar Liv with the people
 * who only attended a coach's session. account_kind says which an account is:
 *
 *   customer  signed up in the app (password signup, Google or One Tap from the
 *             site), or can host, or is an admin, or has paid / a plan
 *   audience  created as a side effect of registering for a webinar, including
 *             Google or One Tap from a webinar page
 *
 * Set explicitly on every creation path. An audience account becomes a customer
 * when it signs in from the app itself, starts a trial, pays, is given a plan or
 * is granted hosting (store.PromoteToCustomer); an admin can move it either way
 * by hand, which records who and when (account_kind_set_by / _at).
 *
 * Backfill, conservatively, since nothing recorded this before:
 *   customer  can_host, is_admin, hosts a webinar, has a subscription row or a
 *             billing order, or has a password (only the app's signup sets one)
 *   audience  no password, has registrations, and was created within two minutes
 *             of the earliest of them (the registration made the account), and
 *             none of the above
 *   customer  everything else (the column default)
 */
ALTER TABLE users
    ADD COLUMN account_kind text NOT NULL DEFAULT 'customer'
        CHECK (account_kind IN ('customer', 'audience')),
    ADD COLUMN account_kind_set_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN account_kind_set_at timestamptz;

UPDATE users u
   SET account_kind = 'audience'
 WHERE NOT u.can_host
   AND NOT u.is_admin
   AND coalesce(u.password_hash, '') = ''
   AND NOT EXISTS (SELECT 1 FROM webinars w WHERE w.host_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM billing_orders o WHERE o.user_id = u.id)
   AND EXISTS (
         SELECT 1 FROM registrations r
          WHERE r.user_id = u.id
          GROUP BY r.user_id
         HAVING min(r.created_at) <= u.created_at + interval '2 minutes'
       );

CREATE INDEX users_account_kind_created ON users (account_kind, created_at DESC);
