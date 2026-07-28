// General-purpose tools: shell, files, HTTP. The ordinary capabilities that make
// an agent useful for anything beyond its one domain.
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const MAX = 20000;
const clip = (s, n = MAX) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars truncated]` : s);

export function generalTools({ cwd = process.cwd() } = {}) {
  return [
    tool({
      name: "shell",
      description: "Run a shell command and return stdout+stderr. Use for builds, tests, git, anything scriptable.",
      inputSchema: z.object({
        command: z.string(),
        timeoutSeconds: z.number().optional().describe("default 120"),
      }),
      execute: async (a) => {
        try {
          const { stdout, stderr } = await exec(process.env.SHELL || "/bin/bash",
            ["-c", a.command], { cwd, timeout: (a.timeoutSeconds ?? 120) * 1000, maxBuffer: 8 << 20 });
          return { exitCode: 0, output: clip((stdout || "") + (stderr || "")) };
        } catch (e) {
          return { exitCode: e.code ?? 1, output: clip((e.stdout || "") + (e.stderr || "") || String(e.message)),
                   timedOut: e.killed ?? false };
        }
      },
    }),
    tool({
      name: "read_file",
      description: "Read a text file. Returns content with a line count.",
      inputSchema: z.object({ path: z.string(), maxLines: z.number().optional() }),
      execute: async (a) => {
        const p = join(cwd, a.path);
        if (!existsSync(p)) return { error: "not found", path: a.path };
        const all = readFileSync(p, "utf8").split("\n");
        const lines = all.slice(0, a.maxLines ?? 2000);
        return { path: a.path, totalLines: all.length, truncated: all.length > lines.length,
                 content: clip(lines.join("\n")) };
      },
    }),
    tool({
      name: "write_file",
      description: "Write a text file, creating parent directories as needed.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (a) => {
        const p = join(cwd, a.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a.content);
        return { written: true, path: a.path, bytes: Buffer.byteLength(a.content) };
      },
    }),
    tool({
      name: "list_dir",
      description: "List a directory. Directories are suffixed with /.",
      inputSchema: z.object({ path: z.string().optional() }),
      execute: async (a) => {
        const p = join(cwd, a.path ?? ".");
        if (!existsSync(p)) return { error: "not found" };
        return { path: a.path ?? ".", entries: readdirSync(p)
          .filter((e) => e !== "node_modules" && e !== ".git")
          .map((e) => (statSync(join(p, e)).isDirectory() ? e + "/" : e)).slice(0, 400) };
      },
    }),
    tool({
      name: "http_request",
      description: "Make an HTTP request and return status, headers and body.",
      inputSchema: z.object({
        url: z.string(), method: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(),
      }),
      execute: async (a) => {
        const r = await fetch(a.url, { method: a.method ?? "GET", headers: a.headers, body: a.body });
        const text = await r.text();
        return { status: r.status, headers: Object.fromEntries(r.headers), body: clip(text, 12000) };
      },
    }),
  ];
}
