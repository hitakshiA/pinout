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
/**
 * Reassembles complete lines from arbitrary byte chunks.
 *
 * Every adapter used to do `String(chunk).split("\n").forEach(sink)`, which
 * treats each chunk as if it began and ended on a line boundary. It does not: a
 * pipe or WebSocket chunk lands wherever the kernel or network put it, so any
 * line long enough to straddle a boundary was silently delivered as two lines.
 *
 * stdout is the ONLY channel by which results leave a rented machine, so this
 * corrupted real output. Measured: a 1247-byte file base64'd to stdout arrived
 * as a 412-byte fragment that still decoded to valid-looking CSV — wrong data
 * that a consumer had no way to detect.
 *
 * The tail of an incomplete line is held until the rest arrives; flush() emits
 * whatever is left when the stream ends (output need not end with a newline).
 */
export function lineAssembler(sink, prefix = "") {
  let partial = "";
  const push = (chunk) => {
    partial += String(chunk);
    if (!partial.includes("\n")) return;
    const parts = partial.split("\n");
    partial = parts.pop();                 // incomplete tail, keep for next chunk
    for (const l of parts) sink(prefix + l);
  };
  push.flush = () => { if (partial !== "") { sink(prefix + partial); partial = ""; } };
  return push;
}

export class LocalAdapter extends ComputeAdapter {
  constructor() { super(); this.jobs = new Map(); }

  async provision(spec) {
    const { spawn } = await import("node:child_process");
    const handle = `local-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    // hold: no job baked in — the machine comes up idle and stays up so the
    // renter can exec against it repeatedly. That is what "rent a machine"
    // means; baking one script in at provision time makes it a one-shot.
    const code = spec.hold
      ? "import time\nwhile True: time.sleep(3600)"
      : (spec.code ?? "print('hello from local')");
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
    const out = lineAssembler(sink);
    j.proc.stdout.on("data", out);
    j.proc.stdout.on("end", () => out.flush());
    const err = lineAssembler(sink, "[stderr] ");
    j.proc.stderr?.on("data", err);
    j.proc.stderr?.on("end", () => err.flush());
  }

  async isAlive(handle) { return this.jobs.get(handle)?.alive ?? false; }

  async exec(handle, code, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const p = spawn("python3", ["-u", "-c", code]);
      const out = lineAssembler(sink), err = lineAssembler(sink, "[stderr] ");
      p.stdout.on("data", out); p.stderr.on("data", err);
      p.on("close", (c) => { out.flush(); err.flush(); resolve({ exitCode: c ?? 0 }); });
      p.on("error", (e) => { sink(`[stderr] ${e.message}`); resolve({ exitCode: 127 }); });
    });
  }

  async writeFile(handle, path, buf) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buf);
    return { bytes: buf.length };
  }

  async readFile(handle, path) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path);
  }

  async listFiles(handle, dir) {
    const { readdir, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const names = await readdir(dir);
    return await Promise.all(names.map(async (n) => {
      try { const st = await stat(join(dir, n));
        return { name: n, size: st.size, isDir: st.isDirectory() }; }
      catch { return { name: n }; }
    }));
  }

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
    // hold: leave the shell session EMPTY. A keep-alive command occupies the
    // session, and Daytona runs a session's commands in order — so an exec
    // issued later queued behind an infinite sleep and never ran at all. In
    // hold mode the sandbox itself is the thing being kept alive; liveness is
    // read from the sandbox, not from a command's exit code.
    let cmdId = null;
    if (!spec.hold) {
      // Base64 the payload. Passing source through a shell -c argument mangles
      // newlines and breaks on any quote the user's code contains.
      const b64 = Buffer.from(spec.code ?? "print('hello')", "utf8").toString("base64");
      const cmd = await sb.process.executeSessionCommand(sid, {
        command: `echo ${b64} | base64 -d | python -u -`,
        runAsync: true,
      });
      cmdId = cmd.cmdId;
    }
    this.jobs.set(sb.id, { sb, sid, cmdId, startedAt: t0, coldStartMs, hold: !!spec.hold });
    return { handle: sb.id, startedAt: t0, coldStartMs };
  }

  async attachStream(handle, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such job ${handle}`);
    if (j.hold) return;            // no baked-in job; output comes from exec()
    // Fire-and-forget. The callback ONLY pushes to the sink — doing work here
    // would block the WebSocket and Daytona drops the stream.
    const out = lineAssembler(sink);
    const err = lineAssembler(sink, "[stderr] ");
    j.streamTask = j.sb.process.getSessionCommandLogs(j.sid, j.cmdId, out, err)
      .catch(() => { /* stream ends when the command does */ })
      .finally(() => { out.flush(); err.flush(); });
  }

  /**
   * Has the job finished? Without this the meter keeps billing a machine whose
   * work is already done — the exact over-charge this system exists to prevent.
   */
  async isAlive(handle) {
    const j = this.jobs.get(handle);
    if (!j) return false;
    // A held machine has no job to finish — it lives until the renter releases
    // it or their seconds run out. Asking "has the command exited?" would end
    // the rental immediately, since there is no command.
    if (j.hold) return true;
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

  /** Run code on a machine that is already up. Streams output, returns exit code. */
  async exec(handle, code, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    const b64 = Buffer.from(code, "utf8").toString("base64");
    const cmd = await j.sb.process.executeSessionCommand(j.sid, {
      command: `echo ${b64} | base64 -d | python -u -`,
      runAsync: true,
    });
    const out = lineAssembler(sink), err = lineAssembler(sink, "[stderr] ");
    const logs = j.sb.process.getSessionCommandLogs(j.sid, cmd.cmdId, out, err)
      .catch(() => {}).finally(() => { out.flush(); err.flush(); });
    // Poll for the exit code; the log stream ends when the command does.
    // Bounded: an unbounded poll turns a stuck command into a rental that keeps
    // billing while the caller sees nothing at all.
    const deadline = Date.now() + Number(env.EXEC_TIMEOUT_MS ?? 600_000);
    let exitCode = null, timedOut = false;
    for (let i = 0; Date.now() < deadline; i++) {
      try {
        const c = await j.sb.process.getSessionCommand(j.sid, cmd.cmdId);
        if (c?.exitCode !== null && c?.exitCode !== undefined) { exitCode = c.exitCode; break; }
      } catch { /* transient */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (exitCode === null) timedOut = true;
    await logs;
    return { exitCode, timedOut };
  }

  async writeFile(handle, path, buf) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    await j.sb.fs.uploadFile(buf, path);
    return { bytes: buf.length };
  }

  async readFile(handle, path) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    return Buffer.from(await j.sb.fs.downloadFile(path));
  }

  async listFiles(handle, dir) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    const items = await j.sb.fs.listFiles(dir);
    return (items ?? []).map((f) => ({
      name: f.name, size: f.size, isDir: f.isDir ?? f.is_dir,
    }));
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
    // Tokens passed explicitly. With MODAL_PROFILE set but no .modal.toml on
    // the box (which is the normal case for a server deploy), the SDK resolves
    // the profile, finds no credentials in it, and fails with "Profile is
    // missing token_id or token_secret" — even though both are in the env.
    const modal = new ModalClient(
      env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET
        ? { tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET }
        : undefined
    );
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
    // hold: idle machine that stays up for the renter to exec against.
    const p = await sb.exec(spec.hold
      ? ["sleep", "infinity"]
      : ["python", "-u", "-c", spec.code ?? "print('hello')"]);
    const job = { sb, p, startedAt: t0, coldStartMs, finished: false, exitCode: null };
    // Watch the PROCESS, not the sandbox. A Modal sandbox outlives the process
    // it ran until its idle timeout, so polling the sandbox reported "alive"
    // long after the work was done — measured at 79 seconds billed for a job
    // that finished in 16.5. Billing a machine whose work is already over is
    // the exact overcharge this system exists to prevent.
    Promise.resolve(p.wait?.())
      .then((code) => { job.finished = true; job.exitCode = code ?? 0; })
      .catch(() => { job.finished = true; });
    this.jobs.set(sb.sandboxId ?? sb.id, job);
    return { handle: sb.sandboxId ?? sb.id, startedAt: t0, coldStartMs };
  }

  async attachStream(handle, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such job ${handle}`);
    (async () => {
      try {
        const out = lineAssembler(sink);
        for await (const chunk of j.p.stdout) out(chunk);
        out.flush();
      } catch { /* process ended */ }
    })();
    // stderr was not captured at all, so a traceback from a GPU job vanished and
    // the buyer saw a job that produced nothing and explained nothing.
    (async () => {
      try {
        const err = lineAssembler(sink, "[stderr] ");
        for await (const chunk of j.p.stderr ?? []) err(chunk);
        err.flush();
      } catch { /* no stderr stream */ }
    })();
  }

  async isAlive(handle) {
    const j = this.jobs.get(handle);
    if (!j) return false;
    if (j.finished) return false;           // the process exited; stop the meter
    try {
      const r = await j.sb.poll();          // sandbox still up (null while running)
      return r === null || r === undefined;
    } catch { return false; }
  }

  async exec(handle, code, sink) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    const p = await j.sb.exec(["python", "-u", "-c", code]);
    const out = lineAssembler(sink), err = lineAssembler(sink, "[stderr] ");
    const pumps = [
      (async () => { try { for await (const c of p.stdout) out(c); } catch {} out.flush(); })(),
      (async () => { try { for await (const c of p.stderr ?? []) err(c); } catch {} err.flush(); })(),
    ];
    const exitCode = await p.wait?.().catch(() => null) ?? null;
    await Promise.all(pumps);
    return { exitCode };
  }

  async writeFile(handle, path, buf) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    // Modal's filesystem writes from a LOCAL path, so stage to a temp file.
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "pinout-up-"));
    const local = join(dir, "payload");
    try {
      await writeFile(local, buf);
      await j.sb.filesystem.copyFromLocal(local, path);
      return { bytes: buf.length };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  async readFile(handle, path) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    return Buffer.from(await j.sb.filesystem.readBytes(path));
  }

  async listFiles(handle, dir) {
    const j = this.jobs.get(handle);
    if (!j) throw new Error(`no such machine ${handle}`);
    const items = await j.sb.filesystem.listFiles(dir);
    return (items ?? []).map((f) => ({ name: f.name ?? f.path, size: f.size, isDir: f.isDir }));
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

/**
 * Lanes name a FLEET, not a supplier. Which upstream capacity a fleet resolves
 * to is an operational detail that belongs here, not in the rate card and not
 * in anything a buyer reads.
 */
const FLEET = { cpu: "daytona", accel: "modal", local: "local" };
export function fleetAdapter(fleet) { return adapterFor(FLEET[fleet] ?? fleet); }

export function adapterFor(provider) {
  const C = ADAPTERS[provider];
  if (!C) throw new Error(`unknown provider ${provider}; have ${Object.keys(ADAPTERS)}`);
  if (!cache.has(provider)) cache.set(provider, new C());
  return cache.get(provider);
}
