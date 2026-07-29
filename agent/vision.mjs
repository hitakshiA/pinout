// Eyes.
//
// An agent that writes image and video pipelines cannot see what it produced,
// so it judges the run by the exit code. That is how a job shipped a video with
// the subject deleted out of it and reported success: the code was fine, the
// output was not, and nothing in the loop was capable of noticing.
//
// This is not a checklist telling the agent what to look for on one task. It is
// a general capability: hand it a file and it tells you what is actually in the
// pixels.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { env } from "../src/config.mjs";

const run = promisify(execFile);

const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export const isVideo = (p) => VIDEO.has(extname(p).toLowerCase());
export const isImage = (p) => IMAGE.has(extname(p).toLowerCase());
export const isVisual = (p) => isVideo(p) || isImage(p);

/** Sample frames across a video, so a check sees the whole thing, not frame 0. */
async function framesFrom(buf, count = 4) {
  const dir = await mkdtemp(join(tmpdir(), "pinout-vision-"));
  const src = join(dir, "in" + Math.random().toString(36).slice(2));
  try {
    await writeFile(src, buf);
    let duration = 0;
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src,
      ]);
      duration = parseFloat(stdout.trim()) || 0;
    } catch { /* fall through to a single grab */ }

    const shots = [];
    const stamps = duration > 0
      ? Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count)
      : [0];
    for (const [i, t] of stamps.entries()) {
      const out = join(dir, `f${i}.jpg`);
      try {
        await run("ffmpeg", [
          "-v", "error", "-y", "-ss", String(t), "-i", src,
          "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "4", out,
        ]);
        shots.push({ at: Number(t.toFixed(2)), bytes: await readFile(out) });
      } catch { /* a frame we cannot grab is not fatal */ }
    }
    return { shots, duration };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ask a multimodal model what is in these images.
 *
 * Deliberately blunt about wanting a literal description. A model asked "did
 * this work?" will tell you it worked; asked "what do you see", it describes an
 * empty gradient, and the agent can draw its own conclusion.
 */
async function describe(images, question) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error("no OPENROUTER_API_KEY, cannot look at anything");
  const model = env.VISION_MODEL ?? env.CLUB_MODEL ?? "google/gemini-3.6-flash";

  const content = [
    {
      type: "text",
      text:
        (question
          ? `${question}\n\n`
          : "") +
        "Describe literally what is visible in each image: the main subject, " +
        "whether a person or object is actually present and how much of the " +
        "frame it occupies, the background, and any obvious artefacts, " +
        "blankness or corruption. Do not guess at intent and do not say " +
        "whether anything succeeded. Describe only what is there.",
    },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${img.bytes.toString("base64")}` },
    })),
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 900,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `vision call failed ${res.status}`);
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("the vision model returned nothing");
  return { model, text };
}

/**
 * Look at a file. Videos are sampled across their length; images go straight
 * through. Returns what is in the pixels, plus the measurements worth having.
 */
export async function look(buf, name, question) {
  if (isVideo(name)) {
    const { shots, duration } = await framesFrom(buf);
    if (!shots.length) {
      return {
        looked: false,
        why: "could not decode any frames from this file, which usually means it is not a playable video",
        bytes: buf.length,
      };
    }
    const { model, text } = await describe(shots, question);
    return {
      looked: true, kind: "video", bytes: buf.length,
      durationSeconds: duration || null,
      framesSampled: shots.map((s) => s.at),
      sawWith: model,
      whatIsVisible: text,
    };
  }
  if (isImage(name)) {
    const { model, text } = await describe([{ bytes: buf }], question);
    return { looked: true, kind: "image", bytes: buf.length, sawWith: model, whatIsVisible: text };
  }
  return {
    looked: false,
    why: `${name} is not an image or a video, so there is nothing to look at`,
    bytes: buf.length,
  };
}
