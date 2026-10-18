/* How a webinar's audience receives the session (types.Webinar.Delivery).
 *
 *   standard  everyone joins the video server, or the WHEP mix for a CDN-broadcast host:
 *             exactly what every webinar did before this column existed.
 *   edge      the stage stays on WebRTC; the audience watches LL-HLS and gets chat, polls
 *             and controls over GET /api/webinars/{slug}/events. Opt-in per webinar,
 *             behind the edge_delivery feature. See docs/edge-delivery.md.
 *
 * Default standard, so every existing row and every client that never sends the field
 * keeps today's behaviour. */
ALTER TABLE webinars
    ADD COLUMN delivery text NOT NULL DEFAULT 'standard'
        CHECK (delivery IN ('standard', 'edge'));
