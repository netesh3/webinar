-- Cloud recording is a per-account switch (types.FeatureCloudRecording).
--
-- It lives in users.features, the same text[] as the other switches
-- (migrations/0048). Absent means off, and nothing in that list defaults to on.
-- A new key is therefore off for every account that already exists — but only if
-- it is not already in the array. This removes it, so a row that had the key
-- written by hand, or by a build that turned cloud recording on, is not left
-- enabled. New accounts start from the column default '{}', which does not
-- contain it. An administrator turns it on per customer from the accounts screen.
UPDATE users
SET features = array_remove(features, 'cloud_recording')
WHERE 'cloud_recording' = ANY (features);

-- The schedule option that asks for a cloud recording. The same decision: existing
-- webinars are not left with it on. A host who is later given the switch can turn
-- it back on from the schedule form.
UPDATE webinars
SET options = options || '{"autoRecord": false}'::jsonb
WHERE options->>'autoRecord' = 'true';
