package api

import "context"

// SetMaintenanceHook runs f first in every maintenance lane, so a test can stand in
// for a slow job.
func SetMaintenanceHook(s *Server, f func(context.Context)) { s.maintenanceHook = f }

// KindForGoogle is kindForGoogle, for the account-kind tests.
var KindForGoogle = kindForGoogle
