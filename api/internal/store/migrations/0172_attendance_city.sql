-- The city each person joined from, as Cloudflare places their network ("Bengaluru"), beside
-- the country and region of migration 0171. Read from the site Worker's X-Viewer-City on the
-- join, and written in the same first-join update, so it is the first join's city too. Kept only
-- with a country. Never the IP. NULL for joins before this (29 Oct 2026), for networks Cloudflare
-- cannot place, and for everyone 0171 leaves NULL.
ALTER TABLE attendance
    ADD COLUMN city text CHECK (char_length(city) <= 64);
