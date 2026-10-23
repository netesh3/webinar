package observe

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
	"go.opentelemetry.io/otel/trace"
)

// maxQueryText bounds db.query.text. The longest statements here are a few hundred bytes;
// anything past this is a generated IN-list, and its tail says nothing new.
const maxQueryText = 2048

/*
QueryTracer returns a pgx tracer that makes each query a child span of the request that
issued it, or nil when telemetry is off — a nil tracer is what pgx has without one, so off
costs nothing.

Written against pgx's own tracer interface rather than taken from a third-party package, to
keep the dependencies to the OpenTelemetry project's own modules; it is a page of code.

Two choices worth knowing:
  - The SQL text is recorded, the arguments never are. Every statement in internal/store is
    parameterised ($1, $2, ...), so the text is the code's, and the arguments are the
    emails, names and phone numbers.
  - A query with no span around it makes no span. Those are the background sweepers and the
    LISTEN connection, which would otherwise each be a one-span trace every few seconds —
    most of the volume, none of the value.
*/
func QueryTracer() pgx.QueryTracer {
	if !Enabled() {
		return nil
	}
	return &queryTracer{tracer: otel.Tracer("github.com/netkumar/webcast/api/internal/store")}
}

type queryTracer struct {
	tracer trace.Tracer
}

type spanKey struct{}

func (t *queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !trace.SpanFromContext(ctx).SpanContext().IsValid() {
		return ctx
	}
	op := sqlOperation(data.SQL)
	text := data.SQL
	if len(text) > maxQueryText {
		text = text[:maxQueryText]
	}
	ctx, span := t.tracer.Start(ctx, op,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemNamePostgreSQL,
			semconv.DBOperationName(op),
			semconv.DBQueryText(text),
		))
	return context.WithValue(ctx, spanKey{}, span)
}

func (t *queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span, ok := ctx.Value(spanKey{}).(trace.Span)
	if !ok {
		return
	}
	defer span.End()
	// No rows is an answer, not a failure: half the lookups here expect it.
	if data.Err != nil && !errors.Is(data.Err, pgx.ErrNoRows) {
		/* The status carries the error's text, which for a Postgres error is its severity,
		 * message and SQLSTATE — not the Detail line, which is where Postgres puts the
		 * offending values ("Key (email)=(...)"). */
		span.SetStatus(codes.Error, data.Err.Error())
		span.SetAttributes(attribute.String("error.type", errorType(data.Err)))
		return
	}
	span.SetAttributes(attribute.Int64("db.response.returned_rows", data.CommandTag.RowsAffected()))
}

// sqlOperation is the statement's first keyword, upper-cased: SELECT, INSERT, WITH, ...
func sqlOperation(sql string) string {
	s := strings.TrimSpace(sql)
	// Skip leading line comments, which some statements here start with.
	for strings.HasPrefix(s, "--") {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = strings.TrimSpace(s[i+1:])
		} else {
			return "QUERY"
		}
	}
	end := strings.IndexFunc(s, func(r rune) bool {
		return r == ' ' || r == '\n' || r == '\t' || r == '\r' || r == '('
	})
	if end > 0 {
		s = s[:end]
	}
	if s == "" {
		return "QUERY"
	}
	return strings.ToUpper(s)
}

// errorType is the SQLSTATE for a Postgres error and a fixed string otherwise, so the
// attribute stays low-cardinality.
func errorType(err error) string {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState()
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "other"
}
