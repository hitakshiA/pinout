// Compute adapters: local, daytona (CPU), modal (GPU).
//
// Contract, and why it is shaped this way:
//   * `attachStream(handle, sink)` must NOT block. Daytona's docs warn that a
//     blocking stdout callback kills the log WebSocket, and the meter must tick
//     even when a job is silent — you are renting time, not output.
//   * `terminate()` reports the wall-clock the PROVIDER will bill, which
//     includes cold start. Measured: Daytona ~2.7s, Modal ~9.7s.
import { ComputeAdapter } from "./interface.mjs";
import { env } from "../../src/config.mjs";

/* ---------------------------------------------------------------- local ---- */
/** Subprocess. Zero cost, zero cold start. Everything is developed against this. */
export class LocalAdapter extends ComputeAdapter {
  constructor() { super(); this.jobs = new Map(); }

  async provision(spec) {
    const { spawn } = await import("node:child_process");
    const handle = `local-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const code = spec.code ?? "print('hello from local')";
    const proc = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const p = spawn("python3", ["-u", "-c", ${JSON.stringify(code)}]);
      p.stdout.pipe(process.stdout); p.stderr.pipe(process.stdout);
      p.on("close", c => process.exit(c ?? 0));
    `]);
    this.jobs.set(handle, { proc, startedAt, alive: true });
    proc.on("close", () => { const j = this.jobs.get(handle); if (j) j.alive = false; });
    return { handle, startedAt, coldStartMs: 0 };
  }

  async attachStream(handle, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such job ${handle}`);
    j.proc.stdout.on("data", (b) => String(b).split("\n").forEach((l) => l.trim() && sink(l)));
  }

  async isAlive(handle) { return this.jobs.get(handle)?.alive ?? false; }

  async terminate(handle) {
    const j = this.jobs.get(handle);
    if (!j) return { seconds: 0, providerReported: false };
    try { j.proc.kill("SIGKILL"); } catch { /* already gone */ }
    this.jobs.delete(handle);
    return { seconds: (Date.now() - j.startedAt) / 1000, providerReported: false };
  }
}

/* -------------------------------------------------------------- daytona ---- */
/** CPU lane. Verified: 2.71s cold start, session streaming, get_metrics_latest. */
export class DaytonaAdapter extends ComputeAdapter {
  constructor() { super(); this.jobs = new Map(); }

  async #client() {
    const { Daytona } = await import("@daytonaio/sdk");
    return new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    });
  }

  async provision(spec) {
    const d = await this.#client();
    const t0 = Date.now();
    const sb = await d.create({
      image: spec.image ?? "python:3.11-slim",
      resources: { cpu: spec.vcpu ?? 1, memory: spec.memGiB ?? 1, disk: spec.diskGiB ?? 3 },
    });
    const coldStartMs = Date.now() - t0;           // Daytona BILLS this window
    const sid = "pinout";
    await sb.process.createSession(sid);
    // Base64 the payload. Passing source through a shell -c argument mangles
    // newlines (JSON escapes arrive as literal backslash-n) and breaks on any
    // quote the user's code contains.
    const b64 = Buffer.from(spec.code ?? "print('hello')", "utf8").toString("base64");
    const cmd = await sb.process.executeSessionCommand(sid, {
      command: `echo ${b64} | base64 -d | python -u -`,
      runAsync: true,
    });
    this.jobs.set(sb.id, { sb, sid, cmdId: cmd.cmdId, startedAt: t0, coldStartMs });
    return { handle: sb.id, startedAt: t0, coldStartMs };
  }

  async attachStream(handle, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such job ${handle}`);
    // Fire-and-forget. The callback ONLY pushes to the sink — doing work here
    // would block the WebSocket and Daytona drops the stream.
    j.streamTask = j.sb.process.getSessionCommandLogs(
      j.sid, j.cmdId,
      (out) => String(out).split("\n").forEach((l) => l.trim() && sink(l)),
      (err) => String(err).split("\n").forEach((l) => l.trim() && sink(`[stderr] ${l}`)),
    ).catch(() => { /* stream ends when the command does */ });
  }

  /**
   * Has the job finished? Without this the meter keeps billing a machine whose
   * work is already done — the exact over-charge this system exists to prevent.
   */
  async isAlive(handle) {
    const j = this.jobs.get(handle);
    if (!j) return false;
    try {
      const c = await j.sb.process.getSessionCommand(j.sid, j.cmdId);
      const code = c?.exitCode ?? c?.exit_code;
      return code === null || code === undefined;
    } catch { return false; }
  }

  /** Provider-side truth for three-way reconciliation. */
  async metrics(handle) {
    const j = this.jobs.get(handle);
    if (!j) return null;
    try {
      // getMetrics() returns a LIST over a time range; getMetricsLatest() the object.
      const m = await j.sb.getMetricsLatest();
      return {
        source: "daytona.getMetricsLatest",
        cpuCount: m.cpuCount ?? m.cpu_count,
        cpuUsedPct: m.cpuUsedPct ?? m.cpu_used_pct,
        memUsed: m.memUsed ?? m.mem_used,
        memTotal: m.memTotal ?? m.mem_total,
        diskUsed: m.diskUsed ?? m.disk_used,
        timestamp: String(m.timestamp),
      };
    } catch { return null; }
  }

  async terminate(handle) {
    const j = this.jobs.get(handle);
    if (!j) return { seconds: 0, providerReported: false };
    try { await j.sb.delete(); } catch { /* already gone */ }
    this.jobs.delete(handle);
    return {
      seconds: (Date.now() - j.startedAt) / 1000,   // includes billed cold start
      coldStartMs: j.coldStartMs,
      providerReported: true,
    };
  }
}

/* ---------------------------------------------------------------- modal ---- */
/** GPU lane. Verified: 9.70s cold start (3.6x Daytona), native stdout iterator. */
export class ModalAdapter extends ComputeAdapter {
  constructor() { super(); this.jobs = new Map(); }

  async provision(spec) {
    const { ModalClient } = await import("modal");
    const modal = new ModalClient();
    const app = await modal.apps.fromName(spec.app ?? "pinout-compute", { createIfMissing: true });
    const image = modal.images.fromRegistry(spec.image ?? "python:3.11-slim");

    const t0 = Date.now();
    const sb = await modal.sandboxes.create(app, image, {
      cpu: spec.vcpu ?? 2,
      memoryMiB: spec.memMiB ?? 8192,
      gpu: spec.gpu ?? undefined,
      // Default is 300s. Long jobs die silently without this.
      timeoutMs: (spec.timeoutSeconds ?? 1800) * 1000,
      idleTimeoutMs: (spec.idleTimeoutSeconds ?? 60) * 1000,
    });
    const coldStartMs = Date.now() - t0;           // Modal BILLS this window
    const p = await sb.exec(["python", "-u", "-c", spec.code ?? "print('hello')"]);
    this.jobs.set(sb.sandboxId ?? sb.id, { sb, p, startedAt: t0, coldStartMs });
    return { handle: sb.sandboxId ?? sb.id, startedAt: t0, coldStartMs };
  }

  async attachStream(handle, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such job ${handle}`);
    (async () => {
      try {
        for await (const chunk of j.p.stdout) {
          String(chunk).split("\n").forEach((l) => l.trim() && sink(l));
        }
      } catch { /* process ended */ }
    })();
  }

  async isAlive(handle) {
    const j = this.jobs.get(handle);
    if (!j) return false;
    try {
      const r = await j.sb.poll();          // null while running
      return r === null || r === undefined;
    } catch { return false; }
  }

  /** Modal's billing API is Team-tier only, so the GPU lane is self-instrumented. */
  async metrics() { return null; }

  async terminate(handle) {
    const j = this.jobs.get(handle);
    if (!j) return { seconds: 0, providerReported: false };
    try { await j.sb.terminate(); } catch { /* already gone */ }
    this.jobs.delete(handle);
    return {
      seconds: (Date.now() - j.startedAt) / 1000,
      coldStartMs: j.coldStartMs,
      providerReported: false,   // no provider-side corroboration on this tier
    };
  }
}

const ADAPTERS = { local: LocalAdapter, daytona: DaytonaAdapter, modal: ModalAdapter };
const cache = new Map();

export function adapterFor(provider) {
  const C = ADAPTERS[provider];
  if (!C) throw new Error(`unknown provider ${provider}; have ${Object.keys(ADAPTERS)}`);
  if (!cache.has(provider)) cache.set(provider, new C());
  return cache.get(provider);
}
