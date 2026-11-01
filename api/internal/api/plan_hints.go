package api

import (
	"fmt"

	"github.com/netkumar/webcast/api/internal/billing"
)

/* upgradeHint is the line a "full" refusal ends with (1 Nov 2026): the first plan on sale that
 * allows more than `have`, as " Professional allows 20 at once." Nothing when no plan does, or
 * the plan with more is contact-only ("Enterprise allows 300 — talk to us."). The numbers are
 * the enforced ones (billing.Plan reads types.PlanStageCap and friends). */
func upgradeHint(have int, capOf func(billing.Plan) int, unit string) string {
	for _, p := range billing.OnSale() {
		if n := capOf(p); n > have {
			if p.ContactOnly {
				return fmt.Sprintf(" %s allows %d%s: write to us.", p.Name, n, unit)
			}
			return fmt.Sprintf(" %s allows %d%s.", p.Name, n, unit)
		}
	}
	return ""
}
