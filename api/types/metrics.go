package types

/* WhatsApp metrics for one host over a window.
 *
 * A plain aggregate of crm_messages. Sent is every outbound message Meta has
 * reported on (sent, delivered, read or failed). Delivered includes read.
 * CostMicros is the sum of stored charges; CostEstimated is true when any of
 * those charges was filled from the rate table rather than from Meta's amount,
 * which is when the page says "about".
 */

type CRMMetricsResponse struct {
	From          string       `json:"from,omitempty"`
	To            string       `json:"to"`
	Sent          int          `json:"sent"`
	Delivered     int          `json:"delivered"`
	Read          int          `json:"read"`
	Failed        int          `json:"failed"`
	CostMicros    int64        `json:"costMicros"`
	CostEstimated bool         `json:"costEstimated"`
	Currency      string       `json:"currency"`
	Failures      []CRMFailure `json:"failures"`
}

/* CRMFailure is one grouped reason messages did not arrive, with a fix in
 * plain language. Code is Meta's error code when the stored text has one. */
type CRMFailure struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
	Count  int    `json:"count"`
	Fix    string `json:"fix"`
}
