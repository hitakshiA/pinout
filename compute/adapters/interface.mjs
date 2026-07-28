/**
 * ComputeAdapter — one interface, three implementations (local, modal, daytona).
 *
 * The tick loop NEVER awaits the adapter's stream. It drains a buffer the
 * adapter fills. You are renting *time*, not output: a job that goes quiet must
 * still burn credits, and a chatty job must not burn faster.
 *
 * Daytona's docs warn that blocking synchronous callbacks in its log stream
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
export const LANES = ["cpu-small", "gpu-t4", "gpu-a100-40"];
