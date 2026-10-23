-- The admin "Cost by host" report's ignore list (api/internal/api/cost_ignore.go): test and
-- staff accounts whose usage should not count as customers'. A rule is an exact email, an
-- email pattern with * wildcards (*@test.dev, *+test@*), or one host by id. Values are kept
-- lower-case (an id is lower-case already), so (kind, value) is unique as written.
CREATE TABLE cost_ignore_rules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       text NOT NULL CHECK (kind IN ('email', 'pattern', 'host')),
    value      text NOT NULL CHECK (value <> '' AND length(value) <= 320),
    note       text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, value)
);
