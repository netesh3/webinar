-- Add is_public and passcode to recordings for shareable recording links
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS passcode text NOT NULL DEFAULT '';
