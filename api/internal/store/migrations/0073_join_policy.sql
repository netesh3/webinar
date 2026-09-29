-- Join without registration and instant webinars are per-account switches
-- (types.FeatureJoinWithoutRegistration, types.FeatureInstantWebinar).
--
-- They live in users.features, the same text[] as the other switches
-- (migrations/0048). Absent means off, and nothing in that list defaults to on.
-- A new key is therefore off for every account that already exists — but only if
-- it is not already in the array. This removes both, so a row that had either
-- written by hand is not left enabled. New accounts start from the column
-- default '{}', which contains neither. An administrator turns one on per
-- customer from the accounts screen.
UPDATE users
SET features = array_remove(array_remove(features, 'join_without_registration'), 'instant_webinar')
WHERE 'join_without_registration' = ANY (features)
   OR 'instant_webinar' = ANY (features);

-- Existing webinars that were saved with registration off go back to required.
-- A host who is later given the switch can turn it off again from the schedule
-- form. Until then, the join path refuses a guest who has not registered.
UPDATE webinars
SET registration_required = true
WHERE registration_required = false;
