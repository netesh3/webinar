-- An admin's per-webinar audience ceiling (types.AudienceCapOverride).
--
-- From now on a webinar admits at most types.MaxWebinarAudience (300) attendees, under the
-- plan's cap, because that is what one video box serves straight to its audience. NULL here
-- is that rule; a number is an admin raising (or lowering) one webinar's ceiling, up to 1000.
ALTER TABLE webinars
    ADD COLUMN IF NOT EXISTS audience_cap_override integer
    CHECK (audience_cap_override IS NULL OR audience_cap_override BETWEEN 1 AND 1000);

/* Nothing already promised loses seats.
 *
 * The scheduling form offered 400 and 500 until now, and a webinar that is live, scheduled or
 * still a draft with such a limit has registrants or a promotion behind it. Those keep their
 * number as an override, so the new 300 ceiling only applies to webinars set up from here on;
 * an admin can take the override off (or lower it) per webinar. Ended webinars are left alone:
 * nobody joins them again. */
UPDATE webinars
   SET audience_cap_override = least(attendee_limit, 1000)
 WHERE attendee_limit > 300
   AND status IN ('draft', 'scheduled', 'live')
   AND kind <> 'meeting'
   AND audience_cap_override IS NULL;
