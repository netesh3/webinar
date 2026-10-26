# Captions box: 4 vCPUs, one room per two vCPUs, no wasted final passes

**Date:** 2026-10-27 · **Status:** decided

## Decisions

1. **The captions box defaults to `s-4vcpu-8gb`** (was `s-2vcpu-4gb`). `CAPTIONS_BOX_SIZE` still overrides it.
2. **The room limit defaults to one room per two vCPUs**, at least one: 1 on `s-2vcpu-4gb`, 2 on `s-4vcpu-8gb`, 4 on an 8-vCPU size (was 2 rooms *per* vCPU, so 4 on the old default). `CAPTIONS_BOX_MAX_ROOMS` still overrides it. Each room's live decoder gets `CAPTIONS_CPUS / MAX_ROOMS` threads instead of every vCPU.
3. **No after-session pass for load tests or deleted webinars.** The API marks a load test's caption dispatch `"final":"skip"`, so the worker never spools its audio. Before every pass, including one resumed after a restart, the worker asks `POST /api/internal/transcripts/wanted`, and drops the room's audio only on `{"wanted":false,"reason":"load_test"}` or `404 {"gone":true}`. Any other answer, including an older API that doesn't have the route, keeps the pass.

## Why

Measured in the browser load test on 2026-10-26 (Grafana, captions box `captions-blr-1`, `s-2vcpu-4gb`):

- **One room** of continuous speech (the load-test presenter speaks without pausing) held the captions container at **1.2–1.6 cores, 60–83% of the box**. Caption delay p90 was **7.8–8.7 s**, against a target of ≤ 4 s. Under the old default of 4 rooms, a second captioned webinar would have overloaded it.
- From 18:43 to 19:03 the box ran at **91–92%**. That was the after-session `large-v3-turbo` pass for a load-test webinar, ending `final transcript for webinar_load-test-lt20261026174102ed: 319 lines, API 404`, because the kit had already deleted the webinar. Twenty minutes of the whole box, for nothing.
- With every room's decoder set to all vCPUs, two rooms on four cores would have run eight threads.

## Cost

`s-4vcpu-8gb` is $0.0714/h against $0.0357/h, so +$0.036/h, only while the captions box runs (exactly while the video box does). For a typical 1-hour session (box up ~2 h) that's +$0.07.

## Revisit when

- The next load test measures caption delay on the new size. The target is p90 ≤ 4 s with one room, and still under it with two.
- Real sessions show the CPU guard stepping down often (more speakers than the test), or shared vCPUs show steal time. Then consider `c-4`.
- Three or more webinars with captions regularly overlap. Then use an 8-vCPU size, or a second captions box per video box.

## Follow-up

When a room waits past the limit it keeps on-device captions, and only the API's log shows it (`captions box: dispatch re-sent…`, with `waiting` and `maxRooms`). A host-facing "server captions are full, captioning on devices" note isn't built.
