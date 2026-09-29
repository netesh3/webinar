-- A webinar registration is an account.
--
-- The address on the form is the same address as users.email. Register creates
-- that row when it is missing (can_host stays false; email_verified_at stays
-- null) and links the registration to it when it already exists.
--
-- Until the address is confirmed, the registration is not a way in. `unverified`
-- is not host review (`pending`) and not a seat they can join (`approved`).
-- The join key exists so the confirmation mail can carry it the moment the
-- same email-verification link is opened; it is not returned before that.
--
-- 0075 is left for the WhatsApp CRM flag, which was written against 0074
-- before email verification took that number.

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_state_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_state_check
    CHECK (state IN ('approved', 'pending', 'declined', 'unverified'));

-- Kept on the row because the CRM opt-in arrives with the form, and the CRM
-- write waits until the address is confirmed. A second submit ORs it on.
ALTER TABLE registrations
    ADD COLUMN whatsapp_opt_in boolean NOT NULL DEFAULT false;
