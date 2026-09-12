-- Co-host: a panelist the host made their equal for this run of the webinar.
--
-- Stored on the same table as the other per-session grants (audio_only,
-- muted_by_host) for the same reason they are: it has to survive that panelist's
-- browser dropping and reconnecting, and it has to NOT survive to the webinar's
-- next occurrence, which is a different row entirely. ClearStageGrants already
-- wipes this table when a webinar ends, so co-host status ends with it for free.
--
-- Deliberately not a wider privilege than the host can revoke: the host_id column
-- on webinars is untouched, so a co-host can be turned back into an ordinary
-- panelist by clearing this one flag, and the webinar's actual owner never
-- changes hands the way transfer-host does.
ALTER TABLE webinar_stage_grants
    ADD COLUMN co_host boolean NOT NULL DEFAULT false;
