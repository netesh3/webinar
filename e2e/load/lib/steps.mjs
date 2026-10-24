/* The ramp-and-hold engine the load tools share, in one process or spread over several.
 *
 * A run is a list of steps (client counts, increasing). Each step adds clients evenly over
 * `rampMs`, holds for `holdMs`, and closes its Step (lib/stats.mjs) with gauges sampled from the
 * clients. Clients record into ctx.step, so every measurement lands in the step it happened in.
 *
 * Several processes (`--workers N`): the parent forks the tool with --worker, gives each worker
 * its share of the clients and of each step, and merges the workers' step dumps. A single Node
 * process is one core; a thousand HLS viewers pulling 1-2 Mbit/s each needs several. */
import { fork } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { rampSchedule, sleep } from "./args.mjs";
import { Step, dumpStep, mergeDumps } from "./stats.mjs";

/** Worker i's share of n (of `workers`): the remainder goes to the first ones. */
export function share(n, workers, i) {
  return Math.floor(n / workers) + (i < n % workers ? 1 : 0);
}

/* runLocal: makeClient(index, ctx) -> { start(): Promise, stop(): Promise, gauges(): {} }.
 * onStep(step) is called as each step closes. Resolves once every client stopped. */
export async function runLocal({ steps, holdMs, rampMs, makeClient, onStep, signal, label = "" }) {
  const ctx = { step: null, stopped: false };
  const clients = [];
  const elu = monitorEventLoopDelay({ resolution: 20 });
  elu.enable();
  try {
    for (const [i, target] of steps.entries()) {
      if (signal?.aborted) break;
      const step = new Step(`step ${i + 1}`, target);
      ctx.step = step;
      elu.reset();
      const cpu0 = process.cpuUsage();
      const t0 = Date.now();
      const sched = rampSchedule(clients.length, target, rampMs);
      for (const at of sched) {
        if (signal?.aborted) break;
        await sleep(t0 + at - Date.now());
        const c = makeClient(clients.length, ctx);
        clients.push(c);
        c.start().catch((e) => step.error("client", e?.message ?? "crash"));
      }
      await sleep(t0 + rampMs + holdMs - Date.now(), signal);
      const g = { clients: clients.length };
      for (const c of clients) {
        for (const [k, v] of Object.entries(c.gauges())) g[k] = (g[k] ?? 0) + v;
      }
      const cpu = process.cpuUsage(cpu0);
      const wall = Math.max(1, Date.now() - t0);
      g.cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / wall) * 100);
      g.maxLoopDelayP99Ms = Math.round(elu.percentile(99) / 1e6);
      step.gauges = g;
      step.close();
      await onStep?.(step);
    }
  } finally {
    ctx.stopped = true;
    elu.disable();
    await Promise.allSettled(clients.map((c) => c.stop()));
  }
  return clients;
}

/* runWorkers forks `script` `workers` times. Each worker is sent
 *   { cmd: "run", index, workers, steps: <its share of each step>, holdMs, rampMs, payload }
 * where payload(i) is whatever that worker needs (its join keys, the target), and answers with
 *   { kind: "step", index: <step index>, dump }   then   { kind: "done" }.
 * onStep(mergedStep, i) is called once every worker has sent step i. */
export async function runWorkers({ script, workers, steps, holdMs, rampMs, payload, onStep, signal, execArgv = [] }) {
  const pending = steps.map(() => []);
  let next = 0;
  const children = [];
  const done = [];
  for (let w = 0; w < workers; w++) {
    const child = fork(script, ["--worker"], { execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child);
    done.push(
      new Promise((resolve) => {
        child.on("message", async (m) => {
          if (m.kind === "step") {
            pending[m.index].push(m.dump);
            while (next < steps.length && pending[next].length === workers) {
              const merged = mergeDumps(`step ${next + 1}`, steps[next], pending[next]);
              await onStep?.(merged, next);
              next++;
            }
          } else if (m.kind === "done") resolve();
        });
        child.on("exit", () => resolve());
      }),
    );
    child.send({
      cmd: "run",
      index: w,
      workers,
      steps: steps.map((n) => share(n, workers, w)),
      holdMs,
      rampMs,
      payload: payload(w),
    });
  }
  const stop = () => children.forEach((c) => c.connected && c.send({ cmd: "stop" }));
  process.once("SIGINT", stop);
  signal?.addEventListener("abort", stop, { once: true });
  await Promise.all(done);
  process.removeListener("SIGINT", stop);
  signal?.removeEventListener("abort", stop);
}

/* workerMain is the --worker side: wait for "run", run the share locally, send each step's dump
 * and "done". makeRun(msg) returns runLocal's makeClient for this worker. */
export function workerMain(makeRun) {
  const ctl = new AbortController();
  process.on("message", async (m) => {
    if (m.cmd === "stop") ctl.abort();
    if (m.cmd !== "run") return;
    const makeClient = await makeRun(m);
    let i = 0;
    // A worker's share of a step can be 0 (or the same as the step before); it still reports,
    // so the parent hears from every worker for every step.
    await runLocal({
      steps: m.steps,
      holdMs: m.holdMs,
      rampMs: m.rampMs,
      makeClient,
      signal: ctl.signal,
      onStep: (step) => process.send({ kind: "step", index: i++, dump: dumpStep(step) }),
    });
    process.send({ kind: "done" });
    setTimeout(() => process.exit(0), 200);
  });
}
