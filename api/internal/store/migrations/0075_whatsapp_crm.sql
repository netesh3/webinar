-- WhatsApp CRM is one per-account switch (types.FeatureWhatsAppCRM).
--
-- Contact tags, contact notes, replay links and WhatsApp number registration
-- were separate keys in users.features (migrations/0048). They gate one product
-- surface, so an account that had any of them keeps that surface under
-- whatsapp_crm. Accounts that had none stay without it: each of those keys
-- defaulted off, and the combined switch does too. A new signup still starts
-- from the column default '{}', which does not contain whatsapp_crm.
--
-- Numbered 0075. 0074_email_verification.sql already landed on main.

UPDATE users
SET features = array_append(features, 'whatsapp_crm')
WHERE NOT ('whatsapp_crm' = ANY (features))
  AND (
       'crm_tags' = ANY (features)
    OR 'crm_notes' = ANY (features)
    OR 'replay_links' = ANY (features)
    OR 'whatsapp_register' = ANY (features)
  );

UPDATE users
SET features = array_remove(
        array_remove(
            array_remove(
                array_remove(features, 'crm_tags'),
                'crm_notes'),
            'replay_links'),
        'whatsapp_register')
WHERE 'crm_tags' = ANY (features)
   OR 'crm_notes' = ANY (features)
   OR 'replay_links' = ANY (features)
   OR 'whatsapp_register' = ANY (features);
