// Compute as a metered stream provider.
//
// The insight that keeps this small: a compute job is just a stream that emits
// ONE TICK PER SECOND. Plug it into the existing meter and 1 credit = 1 second
// falls out for free — along with the burn ledger, HCS checkpoints, the HIP-991
// settlement anchor, the refund, and the verifier. No parallel machinery.
//
// The tick is driven by a timer, NOT by the job's output. You are renting time,
// not output: a silent job still burns, a chatty job does not burn faster. This
// also satisfies Daytona's constraint that its log callback must never block.
import { adapterFor } from "../compute/adapters/index.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.mjs";

export const RATES = JSON.parse(readFileSync(join(ROOT, "compute/rates.json"), "utf8"));

export function laneSpec(lane) {
  const l = RATES.lanes[lane];
  if (!l) throw new Error(`unknown lane ${lane}; have ${Object.keys(RATES.lanes)}`);
  return l;
}

/** Jobs currently running, so status/stop can find them. */
export const jobs = new Map();

export const compute = {
  name: "compute",
  unit: "second",

  /**
   * @param n     max seconds to hold the machine (the credit budget caps it too)
   * @param lane  cpu-small | cpu-4 | gpu-t4 | gpu-a100-40 | local
   * @param code  arbitrary source the agent wants executed
   */
  async *stream({ n = 120, lane = "local", code, sessionId } = {}) {
    const spec = lane === "local"
      ? { provider: "local" }
      : laneSpec(lane);
    const adapter = adapterFor(spec.provider);

    const buffer = [];
    let handle = null, coldStartMs = 0, provisionError = null;

    try {
      const p = await adapter.provision({
        code,
        vcpu: spec.vcpu, memGiB: spec.memGiB, memMiB: (spec.memGiB ?? 8) * 1024,
        gpu: spec.gpu ? String(spec.gpu).replace(/-.*$/, "") : undefined,
        timeoutSeconds: n + 60,
      });
      handle = p.handle;
      coldStartMs = p.coldStartMs ?? 0;
      // Callback only pushes. Any work here would block Daytona's WebSocket.
      await adapter.attachStream(handle, (line) => buffer.push(line));
    } catch (e) {
      provisionError = e;
    }

    if (provisionError) {
      yield { id: "err-0", i: 0, unit: "second", stderr: `provision failed: ${provisionError.message}` };
      return;
    }

    jobs.set(sessionId ?? handle, { handle, adapter, lane, startedAt: Date.now(), coldStartMs });

    try {
      // The meter is ANCHORED TO WALL CLOCK, not to accumulated sleeps.
      //
      // Naively doing `sleep(1000)` then an isAlive() network round-trip makes
      // every "second" take ~1.5s, so the meter under-counts and the billed
      // seconds stop meaning seconds. A held machine costs real wall-clock time
      // whatever our loop is doing, so the tick index is derived from elapsed
      // time and liveness is polled off the hot path.
      const meterStart = Date.now();
      let emitted = 0, alive = true;

      // Liveness polls on its own cadence; its latency cannot drift the meter.
      const poll = setInterval(async () => {
        try { if (await adapter.isAlive?.(handle) === false) alive = false; } catch { /* keep going */ }
      }, 1000);

      try {
        while (emitted < n && alive) {
          const dueAt = meterStart + (emitted + 1) * 1000;
          const wait = dueAt - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));

          // If we fell behind (slow provider, GC), bill every whole second that
          // actually elapsed rather than silently losing them.
          const elapsedSec = Math.floor((Date.now() - meterStart) / 1000);
          while (emitted < Math.min(elapsedSec, n)) {
            const out = buffer.splice(0, buffer.length);
            yield {
              id: `sec-${emitted}`,
              i: emitted,
              unit: "second",
              lane,
              provider: spec.provider,
              elapsedMs: Date.now() - meterStart,
              coldStartMs: emitted === 0 ? coldStartMs : undefined,
              stdout: out.length ? out.join("\n") : "",
            };
            emitted++;
          }
        }
        // Flush any output the job produced in its final moments.
        if (buffer.length) {
          const out = buffer.splice(0, buffer.length);
          yield { id: `sec-${emitted}`, i: emitted, unit: "second", lane,
                  provider: spec.provider, elapsedMs: Date.now() - meterStart,
                  stdout: out.join("\n"), trailing: true };
        }
      } finally {
        clearInterval(poll);
      }
    } finally {
      // Always give the machine back. An orphaned GPU sandbox burns budget in
      // silence, and the buyer is refunded for seconds it did not hold.
      try {
        const t = await adapter.terminate(handle);
        const m = await adapter.metrics?.(handle).catch(() => null);
        jobs.delete(sessionId ?? handle);
        jobs.set(`${sessionId ?? handle}:final`, { terminated: t, metrics: m });
      } catch { /* already gone */ }
    }
  },
};

/** What the machine actually cost, for three-way reconciliation. */
export function jobResult(key) {
  return jobs.get(`${key}:final`) ?? null;
}
