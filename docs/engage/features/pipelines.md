# Pipelines

**Status:** planned (Phase 8)  
**Mock:** contact stage chips; Kanban can wait

## Purpose

A thin sales overlay on contacts: stage + owner. Default vocabulary for
this product: Lead → Registered → Attended → Customer → Churned (mock).
Host can rename.

## Data

- `crm_pipelines` / `crm_stages` (host-scoped, ordered)
- `crm_contacts.stage_id`, `crm_contacts.owner_id` (nullable)

Seed one pipeline on first Engage use.

## Behaviour

- Manual `PATCH /crm/contacts/{id}` `{ stageId, ownerId }`.
- Optional auto-move (feature-flagged): `registered` / `attended` / `no_show`
  → matching stage **if** the host left auto-move on. Never overwrite a
  later stage (Customer) with Registered.
- List filter by stage. Kanban is a later view of the same PATCH.

## Coupling

Auto-move is the webinar joint. Pipelines still useful for imported leads
with no webinar.

## Calls

`GET /crm/pipelines` once (cache in Engage shell). PATCH is the only write
per drag.

## On the contacts screen (plan G)

One pipeline, the five mock stages, rename allowed. Attributed revenue is an analytics goal on the journey (plan H), not a deal amount on the contact. The mock has no Kanban and no second pipeline.
