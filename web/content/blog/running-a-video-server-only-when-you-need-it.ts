import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "running-a-video-server-only-when-you-need-it",
  title: "Running a video server only when you need it",
  description:
    "Why our video server is created before each session and deleted after, what outlives it, and what an incident taught us about timeouts and scheduler design.",
  date: "2026-10-24",
  category: "engineering",
  tags: ["engineering", "architecture", "sfu", "reliability", "video"],
  body: `
    A video server is the busiest machine we run during a session and the idlest one the rest of the day. Most hours, nobody is live. Paying for a large machine around the clock to be ready for the few hours it is used did not make sense, so ours is on-demand: it exists while it is needed, and not otherwise.

    [How Webinar Liv delivers video](/blog/how-webinar-liv-delivers-video) covered what the server does during a session. This post is about its life around the sessions: how it comes and goes, what survives between machines, and what we learned when it went wrong.

    ## Created and deleted, not switched off

    Our first version powered a machine off between sessions and on again before the next one. It worked, but a stopped machine still holds its disk and its address, and still costs something. So we moved to something simpler: the machine is **created** from an image when it is needed, and **deleted** when it is not. Nothing is kept on the machine itself.

    ::diagram[video-box-lifecycle] Created when needed, ready only once its checks pass, drained and deleted when idle. The volume and the address outlive each machine.

    That raises an obvious question. If every session gets a brand-new machine, how is it the same server to everyone else? Two things outlive each machine:

    - **A persistent volume.** It holds what the server needs to be itself: its certificates and credentials, the speech models for captions, and work in progress such as recordings waiting to be uploaded. Each new machine attaches the volume as it boots.
    - **A reserved address.** Browsers, certificates and the relay used by people behind strict firewalls all expect the server at one address. A reserved address is moved onto each new machine, so nothing outside has to change, and no record has to be updated and wait to spread.

    Everything else (the operating system, the runtime and the software) is baked into the image. A fresh image is made after each successful deploy, so a new machine starts with the current software rather than updating itself on boot.

    ## Deciding when it should be up

    Whether the server should be up is a pure function of the state of the world. It should be up if any of these is true:

    - a session is live, or starts within the next 15 minutes, or was due recently and has not started
    - someone has just tried to join, or just created an instant session
    - a recording or transcript is still being finished
    - people are connected to it
    - highlight clips are waiting to be made

    Because it is a function of state, not a series of events, it does not matter if a step is missed. The next one looks at the world again and reaches the same answer.

    The 15 minutes is not arbitrary. It is the moment the host's **Go live** button unlocks and attendees start arriving. A new machine takes about two to four minutes to go from nothing to ready, so 15 minutes leaves room for one or two failed attempts.

    For an instant session, or a join when the server is down, there is no warning. The request that needs it starts creating it there and then, rather than waiting for the next scheduled step, and people see a **Starting servers…** screen with an estimate. That is the price of not running all the time: a couple of minutes, now and then, for an unscheduled session.

    ## Ready means it answers

    A machine that has booted is not a server that works. Before anyone is sent to it, it has to pass three checks, each with a short timeout: the video server answers over HTTPS (which also proves its certificate is in place), the streaming origin answers, and the relay presents a valid certificate. Until then, joins are told it is starting, and they ask again.

    If a machine is not ready within a deadline, it is deleted and the attempt counts as a failure. After a few failures in a row we are alerted, the retries keep going with a growing pause between them, and the host gets a **Try again** button.

    ## Going away carefully

    When nothing needs the server, it waits a while before going. Sessions run late, hosts rejoin, and a server created ten minutes after it was deleted would be wasted effort. Only after a long enough idle period does it begin to drain.

    Draining is cautious by design. The server is not deleted while anything is live, finishing or recording, while anyone is connected, or while something starts soon. If we cannot ask the video server who is connected, we assume someone is, unless its health checks also fail, in which case nobody can be using it. A server that is failing its health check but still has people on it is left alone, and we are alerted instead.

    Once the machine is gone, the address is put back in a safe parking place until the next one.

    ## One step at a time

    A scheduler runs once a minute. Each run makes **one** step: it looks at the desired state and the current state and makes a single change, such as "create a machine", "move the address", "mark it ready" or "delete it". A full start is several runs, not one long operation.

    Two rules keep that safe:

    - **Only one runner at a time.** Each step takes a short lease, and every state change is written only if the lease is still held. Two runners can never both create a machine.
    - **Every cloud action is safe to repeat.** If a create request's reply is lost, the next step finds the machine by its label and adopts it rather than creating a second one. Moving the address checks where it is first, and treats "it is already there" as success.

    ## What went wrong, and what we changed

    On 24 October a new video server came up but could not be reached, and the part of the system that should have fixed it was stuck. Nothing was wrong with the machine. The problem was in how the steps around it were scheduled.

    A new machine had been created, but the address had not yet been moved onto it. So the address still pointed at its parking place, which silently drops traffic. Calls to the video server did not fail; they hung, until whatever was waiting on them gave up.

    One of the scheduler's other jobs checks live sessions for empty rooms. It asks the video server about each one, and those calls had no timeout of their own. With three sessions live, three hung calls used up the whole time the job's group had. The step that would have moved the address ran after it, in the same group, on time that had already run out, so it never did anything.

    And it fed itself. The address was never moved, so the server stayed unreachable. The sessions stayed live, so the next run hung the same way. It took a redeploy to break the loop.

    Here is what we changed, framed as the general lessons:

    - **Bound every call to something that might hang.** A call that hangs is worse than a call that fails, because it holds up whatever is waiting for it. Every call to the video server now has a short timeout of its own, a few seconds, and while the server is not ready the calls are skipped instantly, without being attempted.
    - **Do not let one slow job starve another.** The server's lifecycle step now runs on its own, with its own time budget, alongside the other jobs rather than after them. Each of the other jobs has its own budget too. A job that runs long now only hurts itself.
    - **"Could not ask" is not "nothing there".** The empty-room check used to read a failed call as an empty room. Now an unreachable server is never taken as proof that a room is empty, so a slow server cannot end sessions.
    - **Do not wait on a lock.** Taking a lease now gives up at once if another runner holds it, instead of queuing behind it. A stuck runner can no longer make every other job fail with it.
    - **Make cloud actions idempotent, and re-check them.** Moving the address reads first and treats "already there" as success. A ready server checks every minute that the address is still on it. A parked address is checked too. A machine waiting for its address is no longer deleted at the boot deadline, because a new machine would only be waiting for the same address. Instead it keeps retrying, and we are alerted.
    - **Give user actions their own budget.** Deleting a webinar closes its room on the video server. That call now has its own short deadline, so a slow server cannot make the delete fail.
    - **Test the hang, not just the failure.** We now have tests in which the video server never answers. They check that the server still comes up within one scheduler run, that the other jobs still run, and that deleting a live webinar finishes in a few seconds.

    ## The trade-off

    On-demand has a cost, and we accepted it knowingly. An unscheduled session can wait a couple of minutes for a server. There is one video server, not a fleet, so a problem with it affects every live room until it is fixed. And the lifecycle is a small distributed system of its own, with all the timing problems that implies, as 24 October showed.

    In return, the server costs nothing while nobody is live, every session gets a freshly built machine with the current software, and nothing lingers on a machine between sessions.

    ## In short

    - **Created before a session, deleted after.** A volume and a reserved address make each new machine the same server.
    - **Desired state is a function**, so a missed step costs a minute, not a session.
    - **Ready means it answers**, not that it has booted.
    - **One step per run**, under a lease, with every cloud action safe to repeat.
    - **Bound every call, give every job its own budget**, and never read "could not ask" as "nothing there".
  `,
};
