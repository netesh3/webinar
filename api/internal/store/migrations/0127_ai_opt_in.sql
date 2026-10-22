-- AI writing becomes opt-in: an admin turns it on per host (Admin -> Accounts -> features).
-- 0126 had switched it on in every plan tier; those defaults go. An account an admin already
-- turned on by hand keeps it, being a per-account override, not a plan default.
DELETE FROM plan_features WHERE feature = 'ai';
