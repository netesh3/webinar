package engage

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* handleCRMMetrics is GET /crm/metrics?from=&to=.
 *
 * from is inclusive, to is exclusive. Both are RFC3339 or a date (YYYY-MM-DD,
 * the whole day in UTC). Omit both for the last 30 days. Omit from for
 * everything up to to — the page's "All". A plain aggregate over the
 * (host_id, created_at) index; a daily rollup waits until this is actually slow.
 */
func (s *Module) handleCRMMetrics(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	from, to, err := metricWindow(r.URL.Query().Get("from"), r.URL.Query().Get("to"), time.Now())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	totals, failures, err := s.store.MessageMetrics(r.Context(), user.ID, from, to)
	if err != nil {
		s.fail(w, r, "crm metrics", err)
		return
	}
	out := types.CRMMetricsResponse{
		To:            to.UTC().Format(time.RFC3339),
		Sent:          totals.Sent,
		Delivered:     totals.Delivered,
		Read:          totals.Read,
		Failed:        totals.Failed,
		CostMicros:    totals.CostMicros,
		CostEstimated: totals.CostEstimated,
		Currency:      "INR",
		Failures:      make([]types.CRMFailure, 0, len(failures)),
	}
	if from != nil {
		out.From = from.UTC().Format(time.RFC3339)
	}
	for _, f := range failures {
		out.Failures = append(out.Failures, ExplainFailure(f.Error, f.Count))
	}
	httpx.JSON(w, http.StatusOK, out)
}

func metricWindow(fromRaw, toRaw string, now time.Time) (from, to *time.Time, err error) {
	from, err = parseMetricBound(fromRaw, false)
	if err != nil {
		return nil, nil, err
	}
	to, err = parseMetricBound(toRaw, true)
	if err != nil {
		return nil, nil, err
	}
	now = now.UTC()
	if from == nil && to == nil {
		start := now.Add(-30 * 24 * time.Hour)
		from = &start
		to = &now
	} else if to == nil {
		to = &now
	}
	if from != nil && !from.Before(*to) {
		return nil, nil, errMetricOrder
	}
	return from, to, nil
}

var errMetricOrder = metricErr("from has to be earlier than to.")

type metricErr string

func (e metricErr) Error() string { return string(e) }

func parseMetricBound(raw string, end bool) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		u := t.UTC()
		return &u, nil
	}
	d, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, metricErr("Use a date like 2026-09-01, or a full timestamp.")
	}
	if end {
		d = d.Add(24 * time.Hour)
	}
	u := d.UTC()
	return &u, nil
}

/* recordPricing stores the pricing object on a status callback.
 *
 * Independent of whether the status itself moved forward: Meta can send the
 * charge on a callback whose status we already have. A missing message is
 * ignored inside the store.
 */
func (s *Module) recordPricing(ctx context.Context, hostID string, st wa.Status) {
	if st.Pricing == nil || st.WAMID == "" {
		return
	}
	cat, micros, estimated, ok := Quote(s.rates, PriceInput{
		Category:  st.Pricing.Category,
		Billable:  st.Pricing.Billable,
		HasAmount: st.Pricing.HasAmount,
		Micros:    st.Pricing.Micros,
		Recipient: st.RecipientID,
	})
	if !ok {
		return
	}
	if err := s.store.SetMessagePricing(ctx, hostID, st.WAMID, cat, micros, estimated); err != nil {
		s.log.Error("whatsapp webhook: pricing", "error", err, "host", hostID, "wamid", st.WAMID)
	}
}
