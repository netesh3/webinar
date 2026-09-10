-- Which LiveKit project each webinar's room lives on.
--
-- There used to be one SFU, named by three environment variables, and no reason to record
-- anything: every room was on the only server there was. LiveKit Cloud changes that, because a
-- project has a monthly allowance — when it runs out the operator adds another project, and new
-- sessions have to go there while sessions already running stay where they are.
--
-- WHY THIS IS A COLUMN AND NOT A HASH OF THE SLUG. A room exists on exactly ONE project. Every
-- participant of one webinar connects to that project's URL with a token signed by that
-- project's secret, so if two attendees resolve to two different projects they are not sharing
-- load, they are in two separate rooms that cannot see or hear each other. A deterministic
-- function of the slug would give a stable answer only for as long as the project LIST is
-- unchanged — and the whole point is that the list changes. Adding a project would silently
-- reshuffle the assignment of every existing webinar, including one that is live at the time.
--
-- So the choice is made once, on the first join, and written here. Empty means "not yet
-- chosen", which is the state every existing row starts in and the only state in which the
-- server is allowed to pick.
--
-- The value is a project id from LIVEKIT_PROJECTS, which is why those ids are documented as
-- permanent: renaming one orphans every webinar pinned to it.
ALTER TABLE webinars ADD COLUMN sfu_project text NOT NULL DEFAULT '';

-- Answers "what is still running on the project I am about to retire", which is the question an
-- operator has at the moment they swap projects. Partial, because the unpinned rows are the
-- overwhelming majority on any established database and none of them are interesting here.
CREATE INDEX webinars_sfu_project_idx ON webinars (sfu_project) WHERE sfu_project <> '';
