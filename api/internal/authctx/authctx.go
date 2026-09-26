/*
Package authctx carries the signed-in account on a request context.

Its own package so that both modules can read it: the webinar API (package api) puts the
user there in its session middleware, and the CRM (package engage) reads it in handlers the
webinar API has mounted behind that middleware. Neither has to import the other for it.
*/
package authctx

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
)

type key struct{}

// WithUser returns ctx carrying u. Only the session middleware should call it.
func WithUser(ctx context.Context, u store.User) context.Context {
	return context.WithValue(ctx, key{}, u)
}

// User is the account on ctx, or the zero User when there is none.
func User(ctx context.Context) store.User {
	u, _ := ctx.Value(key{}).(store.User)
	return u
}
