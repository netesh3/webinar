-- Keep the existing Webinar Liv operator on Instant webinar.
--
-- instant_webinar defaults off (migrations/0073). The operator account
-- already uses Instant webinar, so this turns the switch on for that admin
-- once. Other admins stay off until somebody enables it from Accounts.
-- One shot: an admin who later turns it off is not switched back on at boot.
-- The statement is store.OperatorInstantWebinarSQL; a store test fails if
-- the two drift.

UPDATE users
   SET features = array_append(features, 'instant_webinar')
 WHERE is_admin
   AND NOT ('instant_webinar' = ANY (features))
   AND lower(split_part(email, '@', 1)) = 'webinarliv';
