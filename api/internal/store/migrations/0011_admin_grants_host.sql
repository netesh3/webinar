-- Hosting becomes a granted capability, not a self-service one.
--
-- Until now there were two ways for anybody at all to become a host, and both were by design:
--
--   1. POST /api/auth/signup with {"wantsHost": true}
--   2. PATCH /api/me with {"wantsHost": true}
--
-- So the hosting capability was, in practice, a checkbox on the signup form. Anyone who found
-- the URL could create webinars, take registrations from strangers, and start a room. That is
-- fine for a demo and wrong for a product with real coaches and real students in it.
--
-- After this migration `can_host` is only ever written by an admin, and `is_admin` is only ever
-- written by an operator through ADMIN_EMAILS. There is deliberately no endpoint that promotes
-- an admin: a privilege that can be granted in-band can be granted by anyone who takes over one
-- account, and the whole point of this table is that the chain has to start outside the app.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- EXISTING HOSTS KEEP THEIR CAPABILITY. There is no UPDATE here setting can_host = false, and
-- that omission is the important part of this file.
--
-- The tempting reading of "only an admin can make someone a host" is to revoke everyone and
-- start clean. On this deployment that would strip hosting from the accounts that own every
-- webinar already scheduled — their sessions would still exist, with registrants attached, and
-- nobody able to start them. A rule about who may be GRANTED a capability in future is not a
-- reason to take it from people already using it.
--
-- Auditing who currently holds it is a separate job, and one an admin can now do from the panel:
--   SELECT email, can_host, is_admin FROM users WHERE can_host ORDER BY email;

-- Partial, because the only query is "who are the admins" and there are a handful of them
-- against every other row in the table.
CREATE INDEX users_admin_idx ON users (email) WHERE is_admin;
