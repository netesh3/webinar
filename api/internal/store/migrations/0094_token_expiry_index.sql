/* The daily token sweep deletes by expires_at (see store.PruneExpiredTokens);
 * without these it scans both tables. */
CREATE INDEX password_reset_tokens_expires_idx ON password_reset_tokens (expires_at);
CREATE INDEX email_verification_tokens_expires_idx ON email_verification_tokens (expires_at);
