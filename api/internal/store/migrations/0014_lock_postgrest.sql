-- Lock PostgREST: app data is owned by the Go API (DATABASE_URL / postgres),
-- not by Supabase anon/authenticated JWT clients.
--
-- Default Supabase grants give anon + authenticated full table privileges and
-- leave RLS off, so the published anon key (served via GET /api/config for
-- Google Auth only) could CRUD users.password_hash, registrations.join_key, etc.
--
-- Defense in depth:
--   1. REVOKE table/sequence privileges from anon, authenticated, and PUBLIC
--   2. ENABLE ROW LEVEL SECURITY with no permissive policies (default deny for
--      non-owners). Table owner (postgres / pooler) bypasses RLS unless FORCE.
-- Google Auth continues via /auth/v1 (not table REST).

-- ---------------------------------------------------------------- privileges

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;

-- Ensure the Go API role retains full access (idempotent; postgres already owns).
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres;

-- Drop any existing policies on public tables so nothing accidentally permits
-- anon/authenticated. Safe when none exist.
DO $$
DECLARE
    pol record;
BEGIN
    FOR pol IN
        SELECT c.relname AS tbl, p.polname AS name
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.name, pol.tbl);
    END LOOP;
END $$;

-- Enable RLS on every public table (default deny for non-owners).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    END LOOP;
END $$;
