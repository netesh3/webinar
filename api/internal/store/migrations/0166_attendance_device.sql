/* The device each person joined on (api/internal/useragent): phone, tablet or desktop, the OS
 * and the browser, read from the join request's User-Agent. The raw string is not kept.
 *
 * The first join's device, kept for the session: a person who joins on a phone and comes back
 * on a laptop is one attendee, counted where they first arrived. NULL for joins before this
 * existed, for people only the SFU's webhooks saw (the stage), and for our own mix, crawlers
 * and load-test viewers, which the parser calls bots and the join never writes. */
ALTER TABLE attendance
    ADD COLUMN device_class   text CHECK (device_class IN ('phone', 'tablet', 'desktop')),
    ADD COLUMN device_os      text,
    ADD COLUMN device_browser text;
