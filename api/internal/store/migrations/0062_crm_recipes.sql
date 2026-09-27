/* Recipes: ready-made automations a host turns on rather than builds.
 *
 * A recipe is not a new engine. The follow-up recipes are drips and the keyword recipe is a
 * bot, created from a preset the first time a host turns one on, and marked with the
 * recipe's key so the Automations page can find its own. They stay ordinary sequences and
 * bots after that: the builders show them, the sweepers run them, and pausing one is the
 * drip's own switch. The key is unique per host, so turning a recipe off and on again
 * brings back the same drip with the people already on it, rather than a second copy.
 *
 * trigger_tiers narrows the `attended` trigger to the Engagement tab's groups. Those only
 * exist once the webinar's engagement has been computed, which happens after the room is
 * gone — so a drip with tiers is enrolled when the scores are written (EnrollOnScored),
 * and the plain `attended` enrollment at the end skips it.
 *
 * crm_hot_leads is the one recipe with no engine to sit on: a word in somebody's reply
 * tags them. One row per host, and the tag it applies; a deleted tag turns it into a
 * rule that does nothing until it is set up again.
 */
ALTER TABLE crm_drips
    ADD COLUMN recipe text,
    ADD COLUMN trigger_tiers text[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX crm_drips_recipe_idx ON crm_drips (host_id, recipe) WHERE recipe IS NOT NULL;

ALTER TABLE crm_bots ADD COLUMN recipe text;

CREATE UNIQUE INDEX crm_bots_recipe_idx ON crm_bots (host_id, recipe) WHERE recipe IS NOT NULL;

CREATE TABLE crm_hot_leads (
    host_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active     boolean NOT NULL DEFAULT false,
    words      text[] NOT NULL DEFAULT '{}',
    tag_id     uuid REFERENCES crm_tags(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
