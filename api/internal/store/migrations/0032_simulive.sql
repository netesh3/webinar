-- Simulive: play a ready recording as the audience video at the scheduled start.
ALTER TABLE webinars
    ADD COLUMN IF NOT EXISTS simulive_recording_id uuid REFERENCES recordings(id) ON DELETE SET NULL;
