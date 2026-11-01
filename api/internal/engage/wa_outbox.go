package engage

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* flushWhatsAppOutbox sends what is owed on WhatsApp: up to WHATSAPP_SEND_PER_SEC a second
 * (40 by default) from each business number and from this instance in all, for as long as
 * its budget allows.
 *
 * Alongside flushOutbox rather than inside it: the two share the table and nothing
 * else. Mail goes through one transport this application owns, and every row here
 * goes out through a different host's Meta account, under their token, against
 * their bill.
 *
 * The shape (docs/ENGAGE-ARCHITECTURE.md §10.2):
 *
 *   - One flush has whatsappFlushBudget (20 s) and starts a send only with a send's
 *     timeout (10 s) left, so it sends for about 10 s: it reads rate × 10 rows (400 at
 *     40/s). What it does not reach stays pending for the next pass (1 Nov 2026: a
 *     90 s flush inside the tick took the API down).
 *   - Database connections are not per send. One dispatcher reads, re-checks and claims
 *     the rows, a second's worth at a time in one statement (store.ClaimSends); the
 *     workers make Meta's calls holding no connection; two writers record outcomes. One
 *     flush uses at most three of the pool's connections however many sends are in
 *     flight, so ordinary requests keep theirs during a big campaign.
 *   - At most once: a row is claimed 'sent' before it goes to Meta, and the send and its
 *     record run on a context the flush's deadline cannot cut. A send with no answer is
 *     retired, not retried (wa.NoAnswer).
 *   - One contact's rows go to one worker, in the order they came due, so a contact's
 *     24-hour and 1-hour reminders cannot overtake each other.
 *   - One sender across instances: the outbox:whatsapp lease. So this instance's cap is
 *     the deployment's cap, and two instances never claim the same rows (the claim's
 *     SKIP LOCKED and pending check hold even without the lease).
 *
 * Meta's throttling, by error code (developers.facebook.com/docs/whatsapp/cloud-api/
 * support/error-codes):
 *
 *   - 130429 (Cloud API throughput reached) and 80007 (WABA rate limit): that number
 *     sends nothing more this flush, and its refused and unsent rows go back to pending
 *     with no attempt counted. Nothing reached a recipient.
 *   - 131056 (pair rate limit: one message every 6 s to the same person): that row is
 *     retried later (RecordSendAttempt's backoff); the contact's later rows wait for the
 *     next pass so they do not overtake it.
 *   - 131048 (spam rate limit on the number): the host's messages stop for this flush and
 *     go back to pending, and the host is told on their bell, once a day at most.
 *   - 131049 (Meta held back a marketing message for healthy ecosystem engagement): per
 *     recipient, not per host. Meta says to wait 24 h before resending; a broadcast a day
 *     late is a different message, so the row is retired as failed with Meta's reason,
 *     and the rest of the campaign carries on.
 *
 * Each row is re-checked against the template cache immediately before it is sent,
 * which is not belt-and-braces: a template can be paused or deleted by Meta, or
 * edited to take a different number of values, in the day between a reminder being
 * queued and being due. A send that names it then fails and the cost is a message
 * nobody receives, so the row is skipped with the reason instead.
 */
// FlushWhatsAppOutbox sends what is due now, unless another sender holds the
// outbox. It reports whether this call was the sender. The tick does this every
// pass; registrations start one after responding.
func (s *Module) FlushWhatsAppOutbox(ctx context.Context) bool { return s.flushWhatsAppOutbox(ctx) }

const (
	// whatsappFlushBudget bounds one flush, well inside the tick's request (api.tickRequestBudget).
	whatsappFlushBudget = 20 * time.Second
	// whatsappSendTimeout bounds one send. A send starts only with this much budget left.
	whatsappSendTimeout = 10 * time.Second
	// whatsappRecordTimeout bounds the writes after a send, which run past the flush's deadline.
	whatsappRecordTimeout = 10 * time.Second
	// whatsappDefaultPerSec is WHATSAPP_SEND_PER_SEC's default.
	whatsappDefaultPerSec = 40
	// whatsappWriters record outcomes; with the dispatcher, a flush's whole share of the pool.
	whatsappWriters = 2
	// One flush reads between these many rows: rate × sending time, bounded.
	whatsappReadMin, whatsappReadMax = 100, 500
	// whatsappMaxWorkers bounds the sends in flight, whatever the rate.
	whatsappMaxWorkers = 100
)

// SetWhatsAppFlushTiming changes one flush's budget and one send's timeout, for tests.
func (s *Module) SetWhatsAppFlushTiming(budget, send time.Duration) {
	s.waFlushBudget, s.waSendTimeout = budget, send
}

func (s *Module) whatsappTiming() (budget, send time.Duration) {
	budget, send = whatsappFlushBudget, whatsappSendTimeout
	if s.waFlushBudget > 0 {
		budget = s.waFlushBudget
	}
	if s.waSendTimeout > 0 {
		send = s.waSendTimeout
	}
	return budget, send
}

/* waLimits is the send rate: a token bucket per business phone number, and one for the
 * instance, each perSec a second with a burst of perSec. Kept on the Module, so the rate
 * holds across flushes. */
type waLimits struct {
	perSec int
	global *rate.Limiter

	mu      sync.Mutex
	numbers map[string]*rate.Limiter
}

func newWALimits(perSec int) *waLimits {
	if perSec <= 0 {
		perSec = whatsappDefaultPerSec
	}
	return &waLimits{
		perSec:  perSec,
		global:  rate.NewLimiter(rate.Limit(perSec), perSec),
		numbers: map[string]*rate.Limiter{},
	}
}

// wait takes one send's token from number's bucket and the instance's, or fails when the
// wait would pass ctx's deadline.
func (l *waLimits) wait(ctx context.Context, number string) error {
	l.mu.Lock()
	n, ok := l.numbers[number]
	if !ok {
		n = rate.NewLimiter(rate.Limit(l.perSec), l.perSec)
		l.numbers[number] = n
	}
	l.mu.Unlock()
	if err := n.Wait(ctx); err != nil {
		return err
	}
	return l.global.Wait(ctx)
}

func (s *Module) limits() *waLimits {
	s.waLimitsOnce.Do(func() { s.waLimits = newWALimits(s.cfg.WhatsAppSendPerSec) })
	return s.waLimits
}

// whatsappReadLimit is how many rows one flush reads: what it can send in its sending time.
func whatsappReadLimit(perSec int, budget, sendTimeout time.Duration) int {
	n := int(float64(perSec) * (budget - sendTimeout).Seconds())
	return min(max(n, whatsappReadMin), whatsappReadMax)
}

// waJob is one row, re-checked and ready for Meta.
type waJob struct {
	m    crmstore.WhatsAppOutbound
	tmpl types.CRMTemplate
	out  wa.OutgoingTemplate
}

type waOutcome int

const (
	waSent      waOutcome = iota
	waNoAnswer            // may have been delivered: retired, not retried
	waRefused             // Meta refused it: retried with backoff
	waPairLimit           // 131056: retried with backoff
	waHeld                // 131049: retired with Meta's reason
)

type waResult struct {
	job   waJob
	kind  waOutcome
	wamid string
	err   error
}

// waRun is one flush's shared state.
type waRun struct {
	s           *Module
	ctx         context.Context
	sendBy      time.Time // no send starts after this
	sendTimeout time.Duration
	limits      *waLimits
	results     chan<- waResult

	mu       sync.Mutex
	unsent   []string          // claimed and never sent: back to pending at the end
	blocked  map[string]bool   // numbers Meta throttled (130429, 80007)
	stopped  map[string]string // hosts Meta limited (131048), with Meta's sentence
	sent     int
	finished int
}

func (f *waRun) canStart() bool {
	return f.ctx.Err() == nil && time.Now().Before(f.sendBy)
}

func (f *waRun) giveBack(jobs []waJob) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, j := range jobs {
		f.unsent = append(f.unsent, j.m.ID)
	}
}

func (f *waRun) halted(m crmstore.WhatsAppOutbound) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, stopped := f.stopped[m.HostID]
	return f.blocked[m.PhoneNumberID] || stopped
}

func (s *Module) flushWhatsAppOutbox(ctx context.Context) bool {
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		return true
	}
	budget, sendTimeout := s.whatsappTiming()
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	/* One sender at a time, across instances and between the sweep and the flush a
	 * registration or approval triggers. A held lease means another runner is sending;
	 * whatever it missed is due on the next pass. */
	release, ok, err := s.store.TryLease(ctx, "outbox:whatsapp", 2*time.Minute)
	if err != nil || !ok {
		if err != nil {
			s.log.Error("whatsapp outbox: could not take lease", "error", err)
		}
		return false
	}
	defer release()

	limits := s.limits()
	owed, err := s.store.PendingWhatsApp(ctx, whatsappReadLimit(limits.perSec, budget, sendTimeout))
	if err != nil {
		s.log.Error("whatsapp outbox: could not read", "error", err)
		return true
	}
	if len(owed) == 0 {
		return true
	}
	start := time.Now()
	deadline, _ := ctx.Deadline()
	results := make(chan waResult, 2*limits.perSec)
	f := &waRun{
		s: s, ctx: ctx, sendBy: deadline.Add(-sendTimeout), sendTimeout: sendTimeout,
		limits: limits, results: results,
		blocked: map[string]bool{}, stopped: map[string]string{},
	}

	var writers sync.WaitGroup
	for range whatsappWriters {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for r := range results {
				s.recordWhatsApp(ctx, f, r)
			}
		}()
	}
	work := make(chan []waJob)
	var senders sync.WaitGroup
	for range min(limits.perSec, whatsappMaxWorkers) {
		senders.Add(1)
		go func() {
			defer senders.Done()
			for jobs := range work {
				f.sendGroup(jobs)
			}
		}()
	}

	s.dispatchWhatsApp(f, owed, work)
	close(work)
	senders.Wait()
	close(results)
	writers.Wait()

	// What was claimed and never sent goes back, due now, no attempt counted.
	rec, cancelRec := context.WithTimeout(context.WithoutCancel(ctx), whatsappRecordTimeout)
	defer cancelRec()
	if len(f.unsent) > 0 {
		if err := s.store.ReleaseClaims(rec, f.unsent); err != nil {
			s.log.Error("whatsapp outbox: could not put unsent rows back", "error", err, "rows", len(f.unsent))
		}
	}
	for host, why := range f.stopped {
		s.alertWhatsAppLimited(rec, host, why)
	}
	s.log.Info("whatsapp outbox: flushed", "read", len(owed), "sent", f.sent,
		"recorded", f.finished, "back_to_pending", len(f.unsent),
		"seconds", time.Since(start).Seconds(), "per_sec_cap", limits.perSec)
	return true
}

/* dispatchWhatsApp re-checks, claims and hands out the rows, one contact's rows together,
 * about a second's worth (perSec rows) per claim. Its database calls are one at a time,
 * and none is open while it waits for a worker. */
func (s *Module) dispatchWhatsApp(f *waRun, owed []crmstore.WhatsAppOutbound, work chan<- []waJob) {
	var order []string
	byContact := map[string][]crmstore.WhatsAppOutbound{}
	for _, m := range owed {
		if _, ok := byContact[m.ContactID]; !ok {
			order = append(order, m.ContactID)
		}
		byContact[m.ContactID] = append(byContact[m.ContactID], m)
	}
	cache := &waFlush{webinars: map[string]*types.Webinar{}, templates: map[string]waTemplate{}}
	for i := 0; i < len(order) && f.canStart(); {
		var chunk [][]waJob
		var ids []string
		for n := 0; i < len(order) && n < f.limits.perSec; i++ {
			var jobs []waJob
			for _, m := range byContact[order[i]] {
				if j, ok := s.prepareWhatsApp(f.ctx, cache, m); ok {
					jobs = append(jobs, j)
					ids = append(ids, m.ID)
				}
			}
			if len(jobs) > 0 {
				chunk = append(chunk, jobs)
				n += len(jobs)
			}
		}
		if len(ids) == 0 {
			continue
		}
		claimed, err := s.store.ClaimSends(f.ctx, ids)
		if err != nil {
			if f.ctx.Err() == nil {
				s.log.Error("whatsapp outbox: could not claim", "error", err, "rows", len(ids))
			}
			return
		}
		mine := make(map[string]bool, len(claimed))
		for _, id := range claimed {
			mine[id] = true
		}
		for _, jobs := range chunk {
			kept := jobs[:0]
			for _, j := range jobs {
				if mine[j.m.ID] {
					kept = append(kept, j)
				}
			}
			if len(kept) == 0 {
				continue
			}
			select {
			case work <- kept:
			case <-f.ctx.Done():
				f.giveBack(kept)
			}
		}
	}
}

/* sendGroup sends one contact's rows in order. A row that cannot go now (the flush is out
 * of time, the number or the host is held) takes the rest of the contact's rows back to
 * pending with it, so none overtakes it. Holds no database connection. */
func (f *waRun) sendGroup(jobs []waJob) {
	for i, j := range jobs {
		if f.halted(j.m) {
			f.giveBack(jobs[i:])
			return
		}
		waitCtx, cancel := context.WithDeadline(f.ctx, f.sendBy)
		err := f.limits.wait(waitCtx, j.m.PhoneNumberID)
		cancel()
		if err != nil || f.halted(j.m) {
			f.giveBack(jobs[i:])
			return
		}
		sendCtx, cancelSend := context.WithTimeout(context.WithoutCancel(f.ctx), f.sendTimeout)
		wamid, err := f.s.whatsapp.SendTemplate(sendCtx, j.m.Token, j.m.PhoneNumberID, j.out)
		cancelSend()
		if err == nil {
			f.mu.Lock()
			f.sent++
			f.mu.Unlock()
			f.results <- waResult{job: j, kind: waSent, wamid: wamid}
			continue
		}
		if wa.NoAnswer(err) {
			f.results <- waResult{job: j, kind: waNoAnswer, err: err}
			continue
		}
		switch code := wa.MetaCode(err); code {
		case 130429, 80007:
			f.mu.Lock()
			first := !f.blocked[j.m.PhoneNumberID]
			f.blocked[j.m.PhoneNumberID] = true
			f.mu.Unlock()
			if first {
				f.s.log.Warn("whatsapp outbox: Meta throttled this number; it sends nothing more this pass",
					"host", j.m.HostID, "number", j.m.PhoneNumberID, "code", code, "error", err)
			}
			f.giveBack(jobs[i:])
			return
		case 131048:
			f.mu.Lock()
			_, seen := f.stopped[j.m.HostID]
			f.stopped[j.m.HostID] = err.Error()
			f.mu.Unlock()
			if !seen {
				f.s.log.Warn("whatsapp outbox: Meta limited this number for spam; the host's messages wait",
					"host", j.m.HostID, "number", j.m.PhoneNumberID, "error", err)
			}
			f.giveBack(jobs[i:])
			return
		case 131056:
			f.results <- waResult{job: j, kind: waPairLimit, err: err}
			f.giveBack(jobs[i+1:])
			return
		case 131049:
			f.results <- waResult{job: j, kind: waHeld, err: err}
		default:
			f.results <- waResult{job: j, kind: waRefused, err: err}
		}
	}
}

// recordWhatsApp writes one outcome, on a context the flush's deadline cannot cut.
func (s *Module) recordWhatsApp(ctx context.Context, f *waRun, r waResult) {
	rec, cancel := context.WithTimeout(context.WithoutCancel(ctx), whatsappRecordTimeout)
	defer cancel()
	m := r.job.m
	defer func() {
		f.mu.Lock()
		f.finished++
		f.mu.Unlock()
	}()
	if r.kind != waSent {
		s.log.Error("whatsapp outbox: send failed", "kind", m.Kind, "host", m.HostID,
			"contact", m.ContactID, "notification", m.ID, "code", wa.MetaCode(r.err), "error", r.err)
	}
	var err error
	switch r.kind {
	case waSent:
		/* The wamid is what every delivered, read and failed webhook is matched by. If the
		 * write fails the message is missing from the inbox, never sent twice. */
		if _, err := s.store.AppendMessage(rec, m.HostID, m.ContactID, crmstore.MessageInput{
			Direction:      "out",
			Status:         "sent",
			WAMID:          r.wamid,
			Body:           wa.Render(r.job.tmpl.Body, m.Params),
			TemplateName:   r.job.tmpl.Name,
			Attachment:     headerAttachment(r.job.out.HeaderMedia),
			BroadcastID:    m.BroadcastID,
			NotificationID: m.ID,
			WebinarID:      m.WebinarSlug,
		}); err != nil {
			s.log.Error("whatsapp outbox: sent but not recorded", "error", err,
				"host", m.HostID, "contact", m.ContactID, "wamid", r.wamid)
		}
		s.log.Info("whatsapp message sent", "kind", m.Kind, "host", m.HostID,
			"contact", m.ContactID, "template", r.job.tmpl.Name, "wamid", r.wamid)
		return
	case waNoAnswer:
		/* Meta may have delivered it: retired, not retried. A message somebody did not
		 * get is a failure the host can see; a second copy is a fee and an annoyed
		 * contact nobody can take back. */
		err = s.store.GiveUpDelivery(rec, m.ID, "no answer from WhatsApp, so it may have been delivered; "+
			"not sent again so nobody gets it twice ("+r.err.Error()+")")
	case waHeld:
		err = s.store.GiveUpDelivery(rec, m.ID, "WhatsApp did not deliver this marketing message, to keep "+
			"this person's engagement healthy (131049); it is not sent again ("+r.err.Error()+")")
	case waPairLimit, waRefused:
		// Meta answered with a refusal: nothing was sent. Retried with backoff until the
		// attempts run out, Meta's own sentence kept as the reason.
		s.noteWhatsAppError(rec, m.HostID, m.Token, r.err)
		err = s.store.MarkDelivered(rec, m.ID, "failed", r.err.Error())
	}
	if err != nil {
		s.log.Error("whatsapp outbox: could not record a failed send", "error", err, "notification", m.ID)
	}
}

// alertWhatsAppLimited tells the host, on their bell, that Meta has paused their number.
func (s *Module) alertWhatsAppLimited(ctx context.Context, hostID, why string) {
	added, err := s.store.AlertWhatsAppLimited(ctx, hostID,
		"WhatsApp has limited your number",
		"Meta is limiting how many messages your WhatsApp number can send, usually because "+
			"recipients blocked or reported earlier messages. Your queued messages are paused "+
			"and will be retried automatically. Check the number's quality rating in WhatsApp "+
			"Manager. Meta said: "+why)
	if err != nil {
		s.log.Error("whatsapp outbox: could not alert the host", "host", hostID, "error", err)
		return
	}
	if added {
		s.log.Info("whatsapp outbox: host alerted to Meta's limit", "host", hostID)
	}
}

type waTemplate struct {
	tmpl types.CRMTemplate
	err  error
}

// waFlush is the dispatcher's caches for one flush.
type waFlush struct {
	webinars  map[string]*types.Webinar
	templates map[string]waTemplate
}

/* prepareWhatsApp re-checks one row against its template and builds the send. A row that
 * can no longer be sent is skipped with the reason; one whose check could not be made is
 * left pending. */
func (s *Module) prepareWhatsApp(ctx context.Context, f *waFlush, m crmstore.WhatsAppOutbound) (waJob, bool) {
	key := m.HostID + "\x00" + m.TemplateName + "\x00" + m.TemplateLanguage
	cached, ok := f.templates[key]
	if !ok {
		cached.tmpl, cached.err = s.store.Template(ctx, m.HostID, m.TemplateName, m.TemplateLanguage)
		if cached.err == nil || errors.Is(cached.err, store.ErrNotFound) {
			f.templates[key] = cached
		}
	}
	tmpl, err := cached.tmpl, cached.err
	if errors.Is(err, store.ErrNotFound) {
		s.skipWhatsApp(ctx, m, "template "+m.TemplateName+" is no longer in this WhatsApp account")
		return waJob{}, false
	}
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("whatsapp outbox: template lookup", "error", err, "host", m.HostID)
		}
		return waJob{}, false
	}
	/* Not Sendable only for want of a file (a video or document header, a carousel's
	 * card pictures) is settled by fillRich: a broadcast can bring its own, and
	 * fillRich says what is missing when it did not. */
	missingFile := tmpl.Status == "APPROVED" && tmpl.Unsupported == "" && (tmpl.NeedsHeaderFile || tmpl.NeedsCardFiles)
	if !tmpl.Sendable && !missingFile {
		reason := tmpl.Unsupported
		if reason == "" {
			reason = "template " + tmpl.Name + " is " + strings.ToLower(tmpl.Status) + " at Meta"
		}
		s.skipWhatsApp(ctx, m, reason)
		return waJob{}, false
	}
	if len(m.Params) != tmpl.Variables {
		s.skipWhatsApp(ctx, m, "template "+tmpl.Name+" now takes "+
			strconv.Itoa(tmpl.Variables)+" value(s), not "+strconv.Itoa(len(m.Params)))
		return waJob{}, false
	}
	out := wa.OutgoingTemplate{
		To:         m.Phone,
		Name:       tmpl.Name,
		Language:   tmpl.Language,
		BodyParams: m.Params,
	}
	if reason := s.fillRich(ctx, &out, tmpl, m.HostID, m, f.webinars); reason != "" {
		if ctx.Err() != nil {
			return waJob{}, false
		}
		s.skipWhatsApp(ctx, m, reason)
		return waJob{}, false
	}
	return waJob{m: m, tmpl: tmpl, out: out}, true
}
