-- Where each person joined from, as Cloudflare places their network: the ISO 3166-1 alpha-2
-- country (upper case) and the region inside it (the state, for India: "Karnataka"). Never the
-- city or the IP. Read from the site Worker's X-Viewer-Country / X-Viewer-Region on the join.
--
-- Written in the same first-join update as the device (migration 0166), so a person is placed
-- where they first arrived and a reconnect from elsewhere moves nobody. NULL for joins before
-- this (29 Oct 2026), for the stage and the bots the device skips, and for networks Cloudflare
-- cannot place (XX) or Tor (T1).
ALTER TABLE attendance
    ADD COLUMN country text CHECK (country ~ '^[A-Z]{2}$'),
    ADD COLUMN region  text CHECK (char_length(region) <= 64);
