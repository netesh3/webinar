-- One row: the site-wide maintenance banner an admin turns on from Admin -> Dashboard
-- (api/internal/api/site_banner.go). Off until an admin turns it on.
CREATE TABLE IF NOT EXISTS site_banner (
    id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled    boolean NOT NULL DEFAULT false,
    message    text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO site_banner (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
