# Team and SLA

**Status:** planned (Phase 9, plan E). The mock has a team, so this ships.  
**Mock:** dashboard workload, settings team, inbox Mine / Unassigned

## Purpose

More than one person on the same `host_id` inbox. Not a new org model.

## Model

Invitees are `users` rows linked to the host (reuse co-host mechanics if
they already mean “can operate this account”; otherwise a narrow
`crm_members (host_id, user_id, role)`). Roles: owner, agent.

`assignee_id` on `crm_conversations` (or contact until that table exists).

`crm_host_settings.first_response_minutes` (mock: 5).

## Done looks like

- Inbox filters Unassigned / Mine.
- Dashboard: open per agent.
- First-response clock: `last_inbound_at` → first outbound by a human
  (bot messages do not stop the SLA).
- Analytics: % hit SLA.

## Coupling

None. Webinar co-hosts are not automatically inbox agents unless we
explicitly map them.

## Scale / isolation

Every query still `WHERE host_id = $caller’s host`. An agent must not see
another Engage customer. Tests: two members, two hosts, zero cross-read.

## On the settings screen

Roles the mock shows (owner, agent, and a read scope of assigned vs assigned+unassigned). Unassigned policy: leave open, or always assign to one member. SSO and a free-form permission matrix are not on the mock.
