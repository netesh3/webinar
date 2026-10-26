-- Where a session's video server runs (api/internal/api/sfu_pool.go): an area of the box pool,
-- e.g. 'in' (Bangalore) or 'us'. Empty is the pool's default area, which is every session made
-- before the pool had more than one area.
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS sfu_region text NOT NULL DEFAULT '';
