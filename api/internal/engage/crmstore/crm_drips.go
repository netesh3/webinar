package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Drips: the sequence, who is on it, and what is owed next.
 *
 * The difference from a broadcast is that nothing here happens because somebody asked
 * for it now. A drip is a rule, and the rows in crm_drip_enrollments are the rule
 * caught in the middle of applying — which is why this file has two kinds of function
 * that no other CRM file has: the ones a trigger calls, which put people on a
 * sequence without anybody watching, and the one the sweeper calls, which is the only
 * thing that decides a message is due.
 *
 * As in 0045, the messages are notifications. A step comes due, its row is written
 * into the outbox, and from there it is indistinguishable from a reminder: same
 * backoff, same consent re-check, same host's token and bill. See migrations/0046.
 */

// DripInput is a sequence as the host wrote it. Steps are the whole of it: saving
// replaces them, because a sequence read back has to be the one that was sent.
type DripInput struct {
	Name    string
	Trigger string
	// WebinarSlug scopes a webinar trigger to one webinar; empty means every webinar.
	WebinarSlug string
	// TagID scopes a tag_added trigger to one label; empty means any tag. The
	// wildcard is why the column is ON DELETE RESTRICT — see migrations/0049.
	TagID  string
	Active bool
	Steps  []types.CRMDripStep
}

/* SaveDrip writes a sequence, creating it when id is empty and replacing it otherwise.
 *
 * One transaction, and the steps are deleted and rewritten inside it. That is blunter
 * than diffing them and it is deliberate: positions are the identity of a step, so a
 * host who deletes the second of four has renumbered the last two, and a diff would
 * have to guess which of them is "the same step". Nothing points at a step — an
 * enrollment stores the position it has reached — so there is nothing for the rewrite
 * to break.
 *
 * What it does mean is that editing a running sequence moves the people on it: an
 * enrollment at position 2 now waits for whatever step 2 has become. That is the
 * honest reading of "the host changed the sequence", and the alternative (freezing a
 * copy per enrollment) would make an edit apply to nobody who is already on it.
 */
func (s *Store) SaveDrip(ctx context.Context, hostID, id string, in DripInput) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	name := strings.Join(strings.Fields(in.Name), " ")
	if id == "" {
		err = tx.QueryRow(ctx, `
			INSERT INTO crm_drips (host_id, name, trigger_kind, webinar_id, active, trigger_tag_id)
			VALUES ($1::uuid, $2, $3,
			        (SELECT id FROM webinars WHERE slug = $4 AND host_id = $1::uuid), $5,
			        (SELECT id FROM crm_tags WHERE id = NULLIF($6,'')::uuid AND host_id = $1::uuid))
			RETURNING id::text`,
			hostID, name, in.Trigger, in.WebinarSlug, in.Active, in.TagID).Scan(&id)
		if err != nil {
			return "", err
		}
	} else {
		tag, err := tx.Exec(ctx, `
			UPDATE crm_drips
			   SET name = $3, trigger_kind = $4, active = $5, updated_at = now(),
			       webinar_id = (SELECT id FROM webinars WHERE slug = $6 AND host_id = $1::uuid),
			       trigger_tag_id = (SELECT id FROM crm_tags
			                          WHERE id = NULLIF($7,'')::uuid AND host_id = $1::uuid)
			 WHERE host_id = $1::uuid AND id = $2::uuid`,
			hostID, id, name, in.Trigger, in.Active, in.WebinarSlug, in.TagID)
		if err != nil {
			return "", err
		}
		if tag.RowsAffected() == 0 {
			return "", store.ErrNotFound
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM crm_drip_steps WHERE drip_id = $1::uuid`, id); err != nil {
			return "", err
		}
	}

	for i, step := range in.Steps {
		params := step.Params
		if params == nil {
			params = []types.CRMParam{}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_drip_steps
				(drip_id, position, delay_minutes, template_name, template_language, params)
			VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
			id, i, step.DelayMinutes, step.Template, step.Language, params); err != nil {
			return "", err
		}
	}
	return id, tx.Commit(ctx)
}

/* The drip read, with its stats.
 *
 * Enrollment counts and outbox counts side by side, because the two questions a host
 * has about a sequence that has been running for a month are "how many people are on
 * it" and "how many messages has that been".
 */
const dripSelect = `
	SELECT d.id::text, d.name, d.trigger_kind, COALESCE(w.slug,''), COALESCE(w.topic,''),
	       COALESCE(t.id::text,''), COALESCE(t.name,''),
	       d.active, d.created_at,
	       (SELECT count(*) FROM crm_drip_enrollments e
	         WHERE e.drip_id = d.id AND e.state = 'active'),
	       (SELECT count(*) FROM crm_drip_enrollments e
	         WHERE e.drip_id = d.id AND e.state = 'done'),
	       (SELECT count(*) FROM crm_drip_enrollments e
	         WHERE e.drip_id = d.id AND e.state = 'exited'),
	       (SELECT count(*) FROM notifications n
	          JOIN crm_drip_enrollments e ON e.id = n.drip_enrollment_id
	         WHERE e.drip_id = d.id AND n.delivery = 'pending'),
	       (SELECT count(*) FROM notifications n
	          JOIN crm_drip_enrollments e ON e.id = n.drip_enrollment_id
	         WHERE e.drip_id = d.id AND n.delivery = 'sent'),
	       (SELECT count(*) FROM notifications n
	          JOIN crm_drip_enrollments e ON e.id = n.drip_enrollment_id
	         WHERE e.drip_id = d.id AND n.delivery = 'failed')
	  FROM crm_drips d
	  LEFT JOIN webinars w ON w.id = d.webinar_id
	  LEFT JOIN crm_tags t ON t.id = d.trigger_tag_id`

func scanDrip(row scanner) (types.CRMDrip, error) {
	var (
		d         types.CRMDrip
		createdAt time.Time
		st        types.CRMDripStats
	)
	if err := row.Scan(&d.ID, &d.Name, &d.Trigger, &d.WebinarID, &d.WebinarTopic,
		&d.TagID, &d.TagName, &d.Active, &createdAt,
		&st.Active, &st.Done, &st.Exited, &st.Queued, &st.Sent, &st.Failed); err != nil {
		return types.CRMDrip{}, err
	}
	d.CreatedAt = createdAt.Format(time.RFC3339)
	d.Stats = st
	d.Steps = []types.CRMDripStep{}
	return d, nil
}

/* Drips lists a host's sequences, newest first, with their steps.
 *
 * The steps come back in one more query for the whole page rather than one per drip:
 * a host with a dozen sequences of five steps is thirteen queries either way at worst
 * and two at best, and the list screen shows every step.
 */
func (s *Store) Drips(ctx context.Context, hostID string, limit int) ([]types.CRMDrip, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, dripSelect+`
		 WHERE d.host_id = $1::uuid
		 ORDER BY d.created_at DESC
		 LIMIT $2`, hostID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMDrip{}
	at := map[string]int{}
	ids := []string{}
	for rows.Next() {
		d, err := scanDrip(rows)
		if err != nil {
			return nil, err
		}
		at[d.ID] = len(out)
		ids = append(ids, d.ID)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	steps, err := s.pool.Query(ctx, `
		SELECT drip_id::text, delay_minutes, template_name, template_language, params
		  FROM crm_drip_steps
		 WHERE drip_id = ANY($1::uuid[])
		 ORDER BY drip_id, position`, ids)
	if err != nil {
		return nil, err
	}
	defer steps.Close()

	for steps.Next() {
		var (
			dripID string
			step   types.CRMDripStep
		)
		if err := steps.Scan(&dripID, &step.DelayMinutes, &step.Template,
			&step.Language, &step.Params); err != nil {
			return nil, err
		}
		if step.Params == nil {
			step.Params = []types.CRMParam{}
		}
		if i, ok := at[dripID]; ok {
			out[i].Steps = append(out[i].Steps, step)
		}
	}
	return out, steps.Err()
}

// Drip reads one. Another host's id is store.ErrNotFound, like every other CRM read.
func (s *Store) Drip(ctx context.Context, hostID, id string) (types.CRMDrip, error) {
	row := s.pool.QueryRow(ctx, dripSelect+`
		 WHERE d.host_id = $1::uuid AND d.id = $2::uuid`, hostID, id)
	d, err := scanDrip(row)
	if noRows(err) {
		return types.CRMDrip{}, store.ErrNotFound
	}
	if err != nil {
		return types.CRMDrip{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT delay_minutes, template_name, template_language, params
		  FROM crm_drip_steps WHERE drip_id = $1::uuid ORDER BY position`, id)
	if err != nil {
		return types.CRMDrip{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var step types.CRMDripStep
		if err := rows.Scan(&step.DelayMinutes, &step.Template, &step.Language,
			&step.Params); err != nil {
			return types.CRMDrip{}, err
		}
		if step.Params == nil {
			step.Params = []types.CRMParam{}
		}
		d.Steps = append(d.Steps, step)
	}
	return d, rows.Err()
}

/* DeleteDrip removes a sequence, the people on it, and whatever they were owed.
 *
 * The cascade takes the queued outbox rows with it, which is the point: a deleted
 * sequence must not keep sending. It also takes the sent ones, and that is the part
 * worth knowing — the record of a step that actually went out survives in the
 * contact's conversation, where it belongs, and not in the stats of a drip that no
 * longer exists. A host who wants the stats should pause it instead.
 */
func (s *Store) DeleteDrip(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM crm_drips WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// --------------------------------------------------------------- enrolling

/* enrollSelect is the INSERT every trigger shares.
 *
 * `who` is the extra condition that picks the contacts, and the reachability filters
 * are already here: a drip is automatic marketing, so an enrollment for somebody who
 * never opted in would be a row that can only ever sit there or be exited.
 *
 * The join to step 0 is not decoration. A drip with no steps enrolls nobody, and the
 * first step's delay is what next_due_at is, so both facts come from the same row.
 */
const enrollSelect = `
	INSERT INTO crm_drip_enrollments (drip_id, contact_id, webinar_id, next_due_at)
	SELECT d.id, c.id, w.id, now() + (s0.delay_minutes * interval '1 minute')
	  FROM crm_drips d
	  JOIN crm_drip_steps s0 ON s0.drip_id = d.id AND s0.position = 0
	  JOIN webinars w        ON w.slug = $3 AND w.host_id = d.host_id
	  JOIN crm_contacts c    ON c.host_id = d.host_id
	 WHERE d.host_id = $1::uuid AND d.active AND d.trigger_kind = $2
	   AND (d.webinar_id IS NULL OR d.webinar_id = w.id)` + reachable

/* EnrollOnRegistration puts one new registrant on every sequence that fires for them.
 *
 * ON CONFLICT DO NOTHING, which is the rule in migrations/0046: somebody who has
 * already been through this sequence does not go through it again because they
 * registered for a second webinar.
 */
func (s *Store) EnrollOnRegistration(ctx context.Context, hostID, webinarSlug, contactID string) (int, error) {
	tag, err := s.pool.Exec(ctx, enrollSelect+`
		   AND c.id = $4::uuid
		ON CONFLICT DO NOTHING`,
		hostID, types.DripRegistered, webinarSlug, contactID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

/* EnrollOnWebinarEnd puts a finished webinar's registrants on the sequences that fire
 * for them: everybody, the ones who turned up, or the ones who did not.
 *
 * One statement rather than a loop over contacts, because this runs while a webinar is
 * being torn down and a host with two thousand registrants must not turn "End" into
 * two thousand round trips.
 *
 * Attendance is matched through the registration, which is what the attendance table
 * records for anybody who joined with their own link. A registrant who joined as a
 * guest on the public link instead counts as a no-show — the alternative is matching
 * on a name somebody typed, and messaging the wrong person is worse than the
 * occasional wrong bucket.
 */
func (s *Store) EnrollOnWebinarEnd(ctx context.Context, hostID, webinarSlug, trigger string) (int, error) {
	attended := ``
	switch trigger {
	case types.DripAttended:
		attended = ` AND EXISTS (SELECT 1 FROM attendance a
		         WHERE a.webinar_id = w.id AND a.registration_id = r.id)`
	case types.DripNoShow:
		attended = ` AND NOT EXISTS (SELECT 1 FROM attendance a
		         WHERE a.webinar_id = w.id AND a.registration_id = r.id)`
	case types.DripEnded:
	default:
		return 0, store.ErrConflict
	}
	tag, err := s.pool.Exec(ctx, enrollSelect+`
		   AND EXISTS (
		     SELECT 1 FROM registrations r
		      WHERE r.webinar_id = w.id AND r.state <> 'declined'
		        AND `+contactMatchesRegistration+attended+`
		   )
		ON CONFLICT DO NOTHING`,
		hostID, trigger, webinarSlug)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

/* EnrollOnTagAdded puts a contact on every sequence that fires when they get a label.
 *
 * Its own statement rather than enrollSelect with another condition, because that one joins
 * webinars on a slug and there is no slug here: a tag is a fact about a person, not about a
 * session. The enrollment takes the SEQUENCE's own webinar instead — NULL unless the host
 * scoped it to one, in which case that is where the topic and when merge fields come from.
 * Without it the steps have nothing to resolve against, which is the position the manual
 * trigger is in.
 *
 * `trigger_tag_id IS NULL OR = $3` is the wildcard: a sequence that names no tag fires for
 * any of them, which is what a host means by "when I tag somebody, start following up".
 *
 * ON CONFLICT DO NOTHING, like every automatic trigger: somebody who has already been
 * through this sequence does not go through it again because the label came off and back
 * on. Reports how many enrollments it made so the caller can log a send it caused.
 */
func (s *Store) EnrollOnTagAdded(ctx context.Context, hostID, contactID, tagID string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO crm_drip_enrollments (drip_id, contact_id, webinar_id, next_due_at)
		SELECT d.id, c.id, d.webinar_id, now() + (s0.delay_minutes * interval '1 minute')
		  FROM crm_drips d
		  JOIN crm_drip_steps s0 ON s0.drip_id = d.id AND s0.position = 0
		  JOIN crm_contacts c    ON c.host_id = d.host_id AND c.id = $2::uuid
		 WHERE d.host_id = $1::uuid AND d.active AND d.trigger_kind = $4
		   AND (d.trigger_tag_id IS NULL OR d.trigger_tag_id = $3::uuid)`+reachable+`
		ON CONFLICT DO NOTHING`,
		hostID, contactID, tagID, types.DripTagAdded)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

/* EnrollByHand is the manual trigger, and the one enrollment a person did not earn by
 * doing anything.
 *
 * store.ErrConflict when nothing was inserted, unlike the automatic paths: a host who picked
 * a contact and pressed a button is owed the reason, and "they are already on it" is
 * the usual one. The others are a drip with no steps and a contact who cannot be
 * messaged, both of which the API checks first so this stays the last word rather than
 * the only one.
 */
func (s *Store) EnrollByHand(ctx context.Context, hostID, dripID, contactID, webinarSlug string) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO crm_drip_enrollments (drip_id, contact_id, webinar_id, next_due_at)
		SELECT d.id, c.id,
		       (SELECT id FROM webinars WHERE slug = $4 AND host_id = d.host_id),
		       now() + (s0.delay_minutes * interval '1 minute')
		  FROM crm_drips d
		  JOIN crm_drip_steps s0 ON s0.drip_id = d.id AND s0.position = 0
		  JOIN crm_contacts c    ON c.host_id = d.host_id AND c.id = $3::uuid
		 WHERE d.host_id = $1::uuid AND d.id = $2::uuid`+reachable+`
		ON CONFLICT DO NOTHING`,
		hostID, dripID, contactID, webinarSlug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrConflict
	}
	return nil
}

/* DripEnrollments is who is on one sequence, newest first.
 *
 * Capped and unpaged: this is the host looking at a sequence, not an export. Finished
 * and exited enrollments are included — "who has already had this" is most of what
 * the list is for.
 */
func (s *Store) DripEnrollments(ctx context.Context, dripID string, limit int) ([]types.CRMDripEnrollment, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.id::text, c.id::text, c.name, c.phone, e.position, e.state,
		       e.exit_reason, e.next_due_at, COALESCE(w.topic,''), e.created_at
		  FROM crm_drip_enrollments e
		  JOIN crm_contacts c ON c.id = e.contact_id
		  LEFT JOIN webinars w ON w.id = e.webinar_id
		 WHERE e.drip_id = $1::uuid
		 ORDER BY e.created_at DESC, e.id
		 LIMIT $2`, dripID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMDripEnrollment{}
	for rows.Next() {
		var (
			e     types.CRMDripEnrollment
			due   time.Time
			since time.Time
		)
		if err := rows.Scan(&e.ID, &e.ContactID, &e.ContactName, &e.Phone, &e.Step,
			&e.State, &e.ExitReason, &due, &e.WebinarTopic, &since); err != nil {
			return nil, err
		}
		if e.State == "active" {
			// Only meaningful while something is still owed. Sending it for a finished
			// enrollment would put a future date next to somebody who is done.
			e.NextDueAt = due.Format(time.RFC3339)
		}
		e.CreatedAt = since.Format(time.RFC3339)
		out = append(out, e)
	}
	return out, rows.Err()
}

/* ExitDripEnrollment stops one person's sequence and says why.
 *
 * Scoped by drip as well as by enrollment, so a caller that has checked the drip
 * belongs to the host has checked the enrollment too.
 *
 * The queued step goes with it. Leaving it pending would be the quiet bug in this
 * whole feature: the outbox would hold a message for somebody the host removed and
 * send it the moment anything about them changed.
 */
func (s *Store) ExitDripEnrollment(ctx context.Context, dripID, enrollmentID, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE crm_drip_enrollments
		   SET state = 'exited', exit_reason = $3, updated_at = now()
		 WHERE id = $1::uuid AND drip_id = $2::uuid AND state <> 'exited'`,
		enrollmentID, dripID, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE notifications
		   SET delivery = 'skipped', delivery_error = $2, delivered_at = now()
		 WHERE drip_enrollment_id = $1::uuid AND delivery = 'pending'`,
		enrollmentID, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* exitDripsForContact takes somebody off every sequence they are on, inside a
 * transaction the caller owns.
 *
 * Called from SetContactWhatsAppOptOut, which is the only place that learns somebody
 * wants it to stop. Doing it there rather than waiting for each sequence to notice at
 * its next step means a host reading the list sees "opted out" against them today,
 * instead of an active enrollment that will quietly never send anything.
 */
func exitDripsForContact(ctx context.Context, q store.Querier, contactID, reason string) error {
	if _, err := q.Exec(ctx, `
		UPDATE crm_drip_enrollments
		   SET state = 'exited', exit_reason = $2, updated_at = now()
		 WHERE contact_id = $1::uuid AND state = 'active'`, contactID, reason); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `
		UPDATE notifications n
		   SET delivery = 'skipped', delivery_error = $2, delivered_at = now()
		 WHERE n.delivery = 'pending' AND n.drip_enrollment_id IN (
		       SELECT id FROM crm_drip_enrollments WHERE contact_id = $1::uuid)`,
		contactID, reason)
	return err
}

// ----------------------------------------------------------------- sweeping

/* DripDue is one enrollment with a step owed, and everything needed to decide what to
 * do about it.
 *
 * Including the contact's consent, which the outbox would check again anyway. It is
 * here because the two outcomes differ: a queued row the outbox refuses to send waits
 * for ever, while an enrollment whose contact has opted out should be closed and said
 * so. The sweeper cannot tell those apart without knowing.
 */
type DripDue struct {
	EnrollmentID string
	DripID       string
	HostID       string
	HostName     string

	ContactID   string
	ContactName string
	Reachable   bool

	// WebinarSlug is the webinar this person entered from, if any: the source of the
	// topic and when merge fields for their steps.
	WebinarSlug string

	// Position is the step owed, and the guard the advance is made with.
	Position         int
	TemplateName     string
	TemplateLanguage string
	Params           []types.CRMParam
}

/* DueDripSteps is every enrollment whose next step is owed.
 *
 * The drip has to be active: pausing a sequence stops the people on it as well as new
 * ones, which is what a host means by pausing. A paused drip's enrollments are left
 * exactly where they are and resume when it is switched back on.
 *
 * Ordered by due time so a backlog drains oldest-first, and limited because this runs
 * every thirty seconds and a host who imported ten thousand contacts should not turn
 * one tick into ten thousand queued messages.
 */
func (s *Store) DueDripSteps(ctx context.Context, limit int) ([]DripDue, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.id::text, d.id::text, d.host_id::text, u.name,
		       c.id::text, c.name,
		       (c.phone <> '' AND c.whatsapp_opt_in_at IS NOT NULL
		        AND (c.whatsapp_opt_out_at IS NULL
		             OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at)),
		       COALESCE(w.slug,''), e.position,
		       s.template_name, s.template_language, s.params
		  FROM crm_drip_enrollments e
		  JOIN crm_drips d       ON d.id = e.drip_id AND d.active
		  JOIN crm_drip_steps s  ON s.drip_id = d.id AND s.position = e.position
		  JOIN crm_contacts c    ON c.id = e.contact_id
		  JOIN users u           ON u.id = d.host_id
		  LEFT JOIN webinars w   ON w.id = e.webinar_id
		 WHERE e.state = 'active' AND e.next_due_at <= now()
		 ORDER BY e.next_due_at, e.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []DripDue{}
	for rows.Next() {
		var d DripDue
		if err := rows.Scan(&d.EnrollmentID, &d.DripID, &d.HostID, &d.HostName,
			&d.ContactID, &d.ContactName, &d.Reachable, &d.WebinarSlug, &d.Position,
			&d.TemplateName, &d.TemplateLanguage, &d.Params); err != nil {
			return nil, err
		}
		if d.Params == nil {
			d.Params = []types.CRMParam{}
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

/* QueueDripStep writes one step into the outbox and moves the enrollment on, at once.
 *
 * One transaction, and the position is the guard: the update only matches an
 * enrollment still sitting at the step just queued, so two sweepers racing on the same
 * row produce one message and one store.ErrConflict rather than two of somebody's phone.
 * That is also why there is no unique index for this — see migrations/0046.
 *
 * The step's own values are resolved by the caller, per person, exactly like a
 * broadcast's: the row records what was promised to this recipient at the moment it
 * was promised.
 */
func (s *Store) QueueDripStep(ctx context.Context, due DripDue, params []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := s.Notify(ctx, tx, store.Notification{
		Kind:             types.NotifyWhatsAppDrip,
		Channel:          "whatsapp",
		ContactID:        due.ContactID,
		DripEnrollmentID: due.EnrollmentID,
		TemplateName:     due.TemplateName,
		TemplateLanguage: due.TemplateLanguage,
		TemplateParams:   params,
	}); err != nil {
		return err
	}

	/* Advanced to the next step, or finished if there is none.
	 *
	 * next_due_at is computed from the step AFTER this one, because a delay is the wait
	 * before a step rather than after it — and it is counted from now rather than from
	 * the time this one was due, so a sequence that fell behind does not fire its
	 * remaining steps back to back to catch up.
	 */
	tag, err := tx.Exec(ctx, `
		UPDATE crm_drip_enrollments e
		   SET position = e.position + 1,
		       state = CASE WHEN EXISTS (
		                 SELECT 1 FROM crm_drip_steps s
		                  WHERE s.drip_id = e.drip_id AND s.position = e.position + 1)
		               THEN 'active' ELSE 'done' END,
		       next_due_at = now() + (COALESCE((
		           SELECT s.delay_minutes FROM crm_drip_steps s
		            WHERE s.drip_id = e.drip_id AND s.position = e.position + 1), 0)
		           * interval '1 minute'),
		       updated_at = now()
		 WHERE e.id = $1::uuid AND e.position = $2 AND e.state = 'active'`,
		due.EnrollmentID, due.Position)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrConflict
	}
	return tx.Commit(ctx)
}
