-- Add can_cdn_broadcast capability to users table (default false, granted by admin)
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_cdn_broadcast boolean NOT NULL DEFAULT false;
