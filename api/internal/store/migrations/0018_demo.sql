-- The "Launch a webinar" demo door: a throwaway host account and a
-- self-expiring webinar, both flagged so they are never mistaken for real
-- ones sharing the same tables.
--
-- is_demo on users marks an account minted by POST /demo/launch rather than
-- signup — same shape as every account otherwise, so nothing downstream that
-- reads a user row needs to special-case it, but an operator auditing accounts
-- can tell it apart from one an admin actually granted hosting to.
--
-- is_demo and demo_expires_at on webinars are read at load time (see
-- WebinarBySlug) to lazily end a demo session once its window has passed,
-- rather than a separate cleanup job: the app already has "this webinar has
-- ended" handling everywhere a webinar is read, so reusing it here needs no
-- new code path, just a new reason to reach it.
ALTER TABLE users
    ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

ALTER TABLE webinars
    ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
    ADD COLUMN demo_expires_at timestamptz;
