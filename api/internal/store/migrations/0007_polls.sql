-- Polls and quizzes.
--
-- A quiz is a poll with a right answer, not a second feature: the question, the
-- options, the voting and the tallying are identical, and the only differences are
-- that a quiz stores which option is correct and that the correct one is withheld
-- until voting closes. Two tables would have meant two of everything to keep in
-- step.
--
-- Prepared before the session and launched during it, which is why `state` exists.
-- A host writes their questions while planning and opens them one at a time when
-- the moment comes — the same shape Zoom uses, and the reason polls are a child
-- table rather than something transient in a process.
CREATE TABLE polls (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    question   text NOT NULL,
    -- poll → no right answer, results are opinion
    -- quiz → one option is correct, revealed when voting closes
    kind       text NOT NULL DEFAULT 'poll' CHECK (kind IN ('poll', 'quiz')),
    -- A JSON array of option labels. An array rather than an options table: they
    -- are only ever read and written whole, they are ordered, and a join to fetch
    -- four strings would be a join per poll for nothing.
    options    jsonb NOT NULL,
    -- Index into options. NULL for a poll, and NOT NULL is not enforceable here
    -- because the constraint depends on kind — checked below instead.
    correct_option int,
    -- draft  → written, not yet shown to anyone
    -- open   → accepting votes
    -- closed → final, results are fixed
    state      text NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft', 'open', 'closed')),
    -- Whether the audience sees the tally. Off is for a host who wants the answers
    -- without showing the room how it voted.
    share_results boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    opened_at  timestamptz,
    closed_at  timestamptz,

    -- A quiz needs a right answer and a poll must not have one. Enforced here
    -- rather than in a handler, because a quiz with no correct option would show
    -- every answer as wrong and there would be no way to tell that from a poll.
    CONSTRAINT polls_correct_option_matches_kind CHECK (
        (kind = 'quiz' AND correct_option IS NOT NULL) OR
        (kind = 'poll' AND correct_option IS NULL)
    ),
    -- At least two options, and a ceiling so one poll cannot become a form.
    CONSTRAINT polls_option_count CHECK (
        jsonb_typeof(options) = 'array' AND
        jsonb_array_length(options) BETWEEN 2 AND 10
    ),
    -- The correct answer has to be one of the options on offer.
    CONSTRAINT polls_correct_option_in_range CHECK (
        correct_option IS NULL OR
        (correct_option >= 0 AND correct_option < jsonb_array_length(options))
    )
);

-- One poll open at a time per webinar.
--
-- A partial unique index rather than a check in the launch handler: two hosts — or
-- one host double-clicking — both reach the database, and exactly one of them wins.
-- An audience looking at two open polls at once has no way to know which the host
-- meant, and the room would answer both.
CREATE UNIQUE INDEX polls_one_open_per_webinar
    ON polls (webinar_id) WHERE state = 'open';

CREATE INDEX polls_by_webinar ON polls (webinar_id, created_at);

-- One vote per person per poll, by primary key.
--
-- Keyed on the participant identity we mint rather than on a user id, because most
-- of an audience has no account — their identity comes from their join key and is
-- stable across a reconnect, so reloading the page does not buy a second vote.
--
-- The primary key IS the rule. Checking for an existing vote in the handler first
-- leaves a window where two requests both find nothing and both insert.
CREATE TABLE poll_votes (
    poll_id  uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    identity text NOT NULL,
    choice   int  NOT NULL CHECK (choice >= 0),
    voted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, identity)
);

-- Whether the audience may be polled at all, alongside the other in-session
-- controls. A host who has not prepared anything should not have a Polls button
-- appearing in five hundred browsers.
ALTER TABLE webinars
    ADD COLUMN polls_enabled boolean NOT NULL DEFAULT true;
