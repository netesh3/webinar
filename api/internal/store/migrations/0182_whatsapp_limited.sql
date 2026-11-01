-- whatsapp_limited: a host's bell when Meta stops their number sending for a while
-- (WhatsApp error 131048, spam rate limit): their outbox pauses for the pass and the host
-- is told why, once a day at most (engage.flushWhatsAppOutbox).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder',
    'wa_registration_confirmed',
    'wa_reminder',
    'wa_broadcast',
    'wa_drip',
    'replay_ready',
    'wa_replay',
    'welcome',
    'panelist_invited',
    'panelist_rescheduled',
    'panelist_cancelled',
    'email_verify',
    'password_reset',
    'host_request',
    'sales_handoff',
    'sales_reply',
    'session_recap',
    'recording_expiring',
    'ops_alert',
    'whatsapp_limited'
));
