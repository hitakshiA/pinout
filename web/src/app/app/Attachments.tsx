"use client";

import { useEffect, useState } from "react";
import { kindOf, fmtBytes, type Kind } from "./files";

/**
 * Files, shown as objects rather than as a list of names.
 *
 * A comma-separated string of filenames under the composer tells you a file is
 * attached but not which one, and once the message is sent it disappears
 * entirely, so scrolling back through a chat gives you the agent's answer with
 * no sign of what it was answering about. A picture of the thing you attached,
 * left in the transcript where you attached it, fixes both.
 */

const ICON: Record<Kind, string> = {
  image: "M3 5h18v14H3z M8 11l3 3 3-4 4 5",
  video: "M3 5h18v14H3z M10 9l5 3-5 3z",
  audio: "M12 3v13 M12 16a3 3 0 1 1-3 3 M16 6l4-2v10",
  pdf: "M6 3h8l4 4v14H6z M14 3v4h4",
  doc: "M6 3h8l4 4v14H6z M14 3v4h4 M9 13h6 M9 17h4",
  sheet: "M4 4h16v16H4z M4 10h16 M4 15h16 M10 4v16",
  text: "M6 3h8l4 4v14H6z M9 12h6 M9 16h6",
  code: "M9 8l-4 4 4 4 M15 8l4 4-4 4",
  archive: "M4 4h16v16H4z M10 4v6l2-1.5L14 10V4",
};

function Glyph({ kind }: { kind: Kind }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      {ICON[kind].split(" M").map((d, i) => (
        <path key={i} d={i ? `M${d}` : d} />
      ))}
    </svg>
  );
}

/** A thumbnail for the things that have one, an icon for the things that do not. */
function Thumb({ kind, src }: { kind: Kind; src: string | null }) {
  if (src && kind === "image") {
    return <img className="ws-chip-thumb" src={src} alt="" />;
  }
  if (src && kind === "video") {
    // muted+preload gives a poster frame without asking for a separate one
    return <video className="ws-chip-thumb" src={src} muted preload="metadata" />;
  }
  return <span className="ws-chip-glyph" data-kind={kind}><Glyph kind={kind} /></span>;
}

export type Attached = {
  name: string;
  bytes: number;
  /** a URL that renders the file, when there is one */
  src?: string | null;
};

/** In the composer: what you are about to send, each removable. */
export function PendingFiles({
  files, onRemove, onOpen,
}: {
  files: File[];
  onRemove: (i: number) => void;
  onOpen: (f: File, url: string) => void;
}) {
  const [urls, setUrls] = useState<string[]>([]);

  // Every file gets a URL, not just the ones with a thumbnail: checking you
  // picked the right video before paying to process it is the whole point, and
  // that needs something to point the player at. Revoked together so a fast
  // add-then-remove cannot leak one.
  useEffect(() => {
    const made = files.map((f) => URL.createObjectURL(f));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  if (!files.length) return null;
  return (
    <div className="ws-chips">
      {files.map((f, i) => {
        const kind = kindOf(f.name) ?? "text";
        const previewable = /^(image|video)\//.test(f.type);
        return (
          <div className="ws-chip" key={`${f.name}-${i}`}>
            <button className="ws-chip-open" title={`Open ${f.name}`}
                    disabled={!urls[i]}
                    onClick={() => urls[i] && onOpen(f, urls[i])}>
              <Thumb kind={kind} src={previewable ? urls[i] || null : null} />
              <span className="ws-chip-body">
                <span className="ws-chip-name">{f.name}</span>
                <span className="ws-chip-meta">{fmtBytes(f.size)}</span>
              </span>
            </button>
            <button className="ws-chip-x" onClick={() => onRemove(i)}
                    aria-label={`Remove ${f.name}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.4">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** In the transcript: what you sent, clickable to open the preview. */
export function SentFiles({
  files, onOpen,
}: { files: Attached[]; onOpen?: (name: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="ws-chips ws-chips-sent">
      {files.map((f, i) => {
        const kind = kindOf(f.name) ?? "text";
        return (
          <button className="ws-chip" key={`${f.name}-${i}`}
                  onClick={() => onOpen?.(f.name)} title={f.name}>
            <Thumb kind={kind} src={f.src ?? null} />
            <span className="ws-chip-body">
              <span className="ws-chip-name">{f.name}</span>
              <span className="ws-chip-meta">{fmtBytes(f.bytes)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
