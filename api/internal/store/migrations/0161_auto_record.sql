/* "Record automatically" (Options.AutoRecord) starts a cloud recording once the session is
 * live and somebody is on the stage (api/internal/api/auto_record.go).
 *
 * auto_recording_id is the claim: the id of the recording the server started for it. Set at
 * most once per webinar, atomically, so the sweeper, the LiveKit webhook and Go live (and any
 * number of API instances) can all try and only one recording is ever started. Cleared again
 * only when that start failed, so the next pass retries. A host who stops the automatic
 * recording is not overruled: the claim stays. It also tells the room's metadata that the
 * running recording is the automatic one, for the host's "Recording started automatically". */
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS auto_recording_id uuid;
