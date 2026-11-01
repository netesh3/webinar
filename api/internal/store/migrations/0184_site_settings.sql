-- One row: site-wide switches an admin sets from Admin -> Dashboard -> Site settings
-- (api/internal/api/site_settings.go). Read publicly through GET /api/config.
--
-- downloads_visible: whether /download and every link to it are shown. Off until an admin
-- turns it on, while the desktop and mobile apps are not ready (1 Nov 2026). The installer
-- files and latest.json on downloads.webinarliv.com are not affected either way.
CREATE TABLE IF NOT EXISTS site_settings (
    id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    downloads_visible boolean NOT NULL DEFAULT false,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
