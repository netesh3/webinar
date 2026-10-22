/* The room's AI switch (types.SessionControls.AIEnabled): whether one session is in AI —
 * a transcript captured for the AI recap, and the recap itself. On by default, so a host
 * whose account has the ai feature gets the recap without asking; it reads as off for an
 * account without the feature (the read ANDs it with the feature), so nothing changes for
 * them. The host or a co-host turns it off from the room to keep that session out of AI. */
ALTER TABLE webinars ADD COLUMN ai_enabled boolean NOT NULL DEFAULT true;
