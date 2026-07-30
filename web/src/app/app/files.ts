/**
 * What the workspace accepts, and what it can show you.
 *
 * These two questions have the same answer, so they live together. A file the
 * agent cannot open is not worth uploading, and a file it can open is worth
 * previewing rather than making someone download it to find out what happened.
 *
 * The list is an allowlist. A blocklist would let a .dmg through, cost the
 * human a machine rental, and fail on the far side where it is expensive.
 */

export type Kind =
  | "image" | "video" | "audio" | "pdf" | "doc" | "sheet" | "text" | "code" | "archive";

const BY_EXT: Record<string, Kind> = {};
const add = (kind: Kind, exts: string) =>
  exts.split(" ").forEach((e) => { BY_EXT[e] = kind; });

add("image", "jpg jpeg png webp gif bmp tif tiff avif heic svg");
add("video", "mp4 mov avi mkv webm m4v mpg mpeg");
add("audio", "mp3 wav m4a flac ogg aac opus wma");
add("pdf", "pdf");
add("doc", "docx doc odt rtf epub html htm md markdown");
add("sheet", "csv tsv xlsx xls ods parquet");
add("text", "txt log json jsonl xml yaml yml ini toml");
add("code", "py js ts tsx jsx sh sql r ipynb c cpp java go rs rb");
add("archive", "zip tar gz tgz bz2 7z rar");

/** What each kind is for, in the words someone uploading a file would use. */
export const WHAT_IT_DOES: Record<Kind, string> = {
  image: "reads it and describes what it sees",
  video: "samples frames and describes them, and can edit it",
  audio: "transcribes it",
  pdf: "extracts the text and tables",
  doc: "converts it to text it can work with",
  sheet: "loads it as data",
  text: "reads it",
  code: "reads and runs it",
  archive: "unpacks it on the machine",
};

export const extOf = (name: string) =>
  name.toLowerCase().split(".").pop() ?? "";

export const kindOf = (name: string): Kind | null => BY_EXT[extOf(name)] ?? null;

export const ACCEPT = Object.keys(BY_EXT).map((e) => `.${e}`).join(",");

/** 512 MB is what the asset store holds; above 32 MB is staged in pieces. */
export const MAX_BYTES = 512 * 1024 * 1024;

export function checkFile(f: { name: string; size: number }): string | null {
  const kind = kindOf(f.name);
  if (!kind) {
    const ext = extOf(f.name);
    return `${f.name} is not a file type the agent can work with` +
           `${ext ? ` (.${ext})` : ""}. It handles images, video, audio, PDFs, ` +
           `documents, spreadsheets, text, code and archives.`;
  }
  if (f.size > MAX_BYTES) {
    return `${f.name} is ${fmtBytes(f.size)}, over the ${fmtBytes(MAX_BYTES)} limit.`;
  }
  if (f.size === 0) return `${f.name} is empty.`;
  return null;
}

export const fmtBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB`
  : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB`
  : b >= 1024 ? `${Math.ceil(b / 1024)} KB`
  : `${b} B`;
