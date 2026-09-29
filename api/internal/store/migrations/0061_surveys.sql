/* Post-event surveys: one per webinar, either a built-in rating survey or a link to the
 * host's own form. See api/types/survey.go for the two modes.
 *
 * Rules that have a race live here rather than in a handler:
 *
 *   one survey per webinar   UNIQUE (webinar_id). The builder upserts on it.
 *   one response each        UNIQUE (survey_id, identity). A re-submit from a second tab,
 *                            or a retried request, lands on the same row.
 *   a link is https          CHECK on external_url, so no writer can store a javascript: or
 *                            http: URL that five hundred browsers would then open.
 *
 * A response row can exist before it is submitted: in link mode, pressing "Open survey"
 * writes link_clicked_at first, and submitted_at stays NULL until the rating (if asked)
 * comes in. "Responded" everywhere means submitted_at IS NOT NULL.
 */
CREATE TABLE surveys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id   uuid NOT NULL UNIQUE REFERENCES webinars(id) ON DELETE CASCADE,
    mode         text NOT NULL CHECK (mode IN ('builtin', 'link')),
    title        text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
    button_label text NOT NULL DEFAULT '' CHECK (char_length(button_label) <= 40),
    external_url text NOT NULL DEFAULT '' CHECK (char_length(external_url) <= 2048),
    ask_rating   boolean NOT NULL DEFAULT true,
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed')),
    send_at      text NOT NULL DEFAULT 'on_end' CHECK (send_at IN ('on_end', 'manual')),
    launched_at  timestamptz,
    closed_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT surveys_link_is_https CHECK (
        mode <> 'link' OR external_url LIKE 'https://_%'
    ),
    -- The built-in survey IS the rating; only the link mode may skip it.
    CONSTRAINT surveys_builtin_asks_rating CHECK (mode <> 'builtin' OR ask_rating)
);

CREATE TABLE survey_questions (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    position  smallint NOT NULL CHECK (position BETWEEN 0 AND 4),
    kind      text NOT NULL CHECK (kind IN ('rating_5', 'nps_10', 'single_choice', 'text')),
    prompt    text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 200),
    required  boolean NOT NULL DEFAULT false,
    options   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
    CONSTRAINT survey_questions_choice_has_options CHECK (
        kind <> 'single_choice' OR jsonb_array_length(options) BETWEEN 2 AND 6
    )
);

-- Deferrable so a reorder can swap two positions inside one transaction.
ALTER TABLE survey_questions
    ADD CONSTRAINT survey_questions_position_unique UNIQUE (survey_id, position)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE survey_responses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id       uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    identity        text NOT NULL,
    registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
    rating          smallint CHECK (rating BETWEEN 1 AND 5),
    submitted_at    timestamptz,
    link_clicked_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (survey_id, identity)
);

-- Results page: newest submissions first.
CREATE INDEX survey_responses_submitted_idx
    ON survey_responses (survey_id, submitted_at DESC)
 WHERE submitted_at IS NOT NULL;

CREATE TABLE survey_answers (
    response_id uuid NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    -- rating_5 (1–5), nps_10 (0–10) and single_choice (an option index) use number;
    -- text uses text. Exactly one of them is set.
    number      smallint CHECK (number BETWEEN 0 AND 10),
    text        text CHECK (char_length(text) BETWEEN 1 AND 1000),
    PRIMARY KEY (response_id, question_id),
    CONSTRAINT survey_answers_one_value CHECK ((number IS NULL) <> (text IS NULL))
);

-- Paging one text question's answers, and the aggregates per question.
CREATE INDEX survey_answers_question_idx ON survey_answers (question_id);
