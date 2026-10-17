/* A template's default field mapping: what fills each {{n}} of its body unless one use
 * says otherwise — {{1}} the first name, {{2}} the webinar title. Set when the host writes
 * the template, editable later, never sent to Meta.
 *
 * On crm_template_defaults beside the coupon and card pictures, which are the other
 * things a host chooses for a template that Meta does not keep. NULL means nothing was
 * saved yet; the app then suggests one from the wording.
 *
 * A reminder, webinar message slot or sequence step that never chose its own values
 * stores an empty list and follows this mapping (resolved when each message is queued),
 * so changing the template's mapping reaches it. One that chose its own keeps them.
 */
ALTER TABLE crm_template_defaults ADD COLUMN params jsonb;
