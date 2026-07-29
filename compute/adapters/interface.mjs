/**
 * ComputeAdapter: one interface, one implementation per fleet.
 *
 * The tick loop NEVER awaits the adapter's stream. It drains a buffer the
 * adapter fills. You are renting *time*, not output: a job that goes quiet must
 * still burn credits, and a chatty job must not burn faster.
 *
 * One fleet's SDK warns that blocking synchronous callbacks in its log stream
 * cause WebSocket disconnections, which is a second reason the tick and the
 * stream must not be coupled.
 */
export class ComputeAdapter {
  /** @returns {Promise<{handle:string, startedAt:number}>} */
  async provision(_spec) { throw new Error("not implemented"); }

  /** Push lines into `sink(line)`. Must not block the caller. */
  async attachStream(_handle, _sink) { throw new Error("not implemented"); }

  /** Provider-side truth, where available. Used for three-way reconciliation. */
  async metrics(_handle) { return null; }

  /** @returns {Promise<{seconds:number, providerReported:boolean}>} */
  async terminate(_handle) { throw new Error("not implemented"); }
}

/** Lanes a client may request. Kept separate from pricing (see rates.json). */
/**
 * Optional capabilities. A machine that is only ever handed one script at
 * provision time is a batch job, not a rented machine — an agent cannot look at
 * a result and decide what to do next, feed the machine an input file, or take
 * an artifact away. Adapters implementing these turn a session into something
 * you can actually work on.
 *
 *   exec(handle, code, sink)   run code on a machine that is already up
 *   writeFile(handle, path, buf)
 *   readFile(handle, path) -> Buffer
 *   listFiles(handle, dir)
 *
 * provision({ hold: true }) brings a machine up idle and keeps it up.
 */
export const LANES = ["cpu-1", "cpu-2", "cpu-4", "gpu-t4", "gpu-l4", "gpu-a10",
  "gpu-l40s", "gpu-a100-80", "gpu-h200", "gpu-b200", "gpu-b300"];
