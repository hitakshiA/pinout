"use client";

import { useEffect, useState } from "react";
import type { Asset } from "./api";

/**
 * Look at what the agent made, without leaving the transcript.
 *
 * Downloading a file to find out whether the job worked is a bad loop: the
 * whole point of watching an agent spend money is being able to judge the
 * result while it is still in front of you. Videos play, images show, text and
 * CSV render, and anything else says plainly that it cannot be shown rather
 * than pretending.
 */

const kindOf = (a: Asset) => {
  const t = a.contentType ?? "";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (a.name.toLowerCase().endsWith(".csv") || t === "text/csv") return "csv";
  if (t.startsWith("text/") || t === "application/json") return "text";
  return "other";
};

const size = (b: number) =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;

/** A CSV as a table, because a wall of commas is not a preview. */
function Csv({ text }: { text: string }) {
  const rows = text.split("\n").filter(Boolean).slice(0, 200).map((r) => r.split(","));
  if (!rows.length) return <div className="ws-empty">Empty file.</div>;
  const [head, ...body] = rows;
  return (
    <div className="ws-tablewrap">
      <table className="ws-table">
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {text.split("\n").length > 201 && (
        <div className="ws-balance-sub" style={{ padding: "10px 2px" }}>
          First 200 rows of {text.split("\n").filter(Boolean).length - 1}.
        </div>
      )}
    </div>
  );
}

export function Preview({
  asset, url, onClose,
}: { asset: Asset; url: string; onClose: () => void }) {
  const kind = kindOf(asset);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "csv" && kind !== "text") return;
    setText(null); setErr(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      // enough to judge the result, not enough to hang the tab on a huge file
      .then((t) => setText(t.slice(0, 400_000)))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [url, kind]);

  return (
    <aside className="ws-preview">
      <header className="ws-preview-top">
        <div style={{ minWidth: 0 }}>
          <div className="ws-preview-name">{asset.name}</div>
          <div className="ws-preview-meta">
            {(asset.contentType ?? "file").split("/").pop()?.toUpperCase()} · {size(asset.bytes)}
            {" · "}<span className="ws-mono">{asset.sha256.slice(0, 12)}</span>
          </div>
        </div>
        <span className="ws-top-spacer" />
        <a className="ws-btn" href={url} download>Download</a>
        <button className="ws-icon-btn" onClick={onClose} aria-label="Close preview">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="ws-preview-body">
        {kind === "video" && (
          <video className="ws-media" src={url} controls autoPlay loop muted playsInline />
        )}
        {kind === "image" && <img className="ws-media" src={url} alt={asset.name} />}
        {kind === "audio" && <audio style={{ width: "100%" }} src={url} controls />}
        {kind === "csv" && (err ? <div className="ws-empty">{err}</div>
          : text == null ? <div className="ws-empty">Loading…</div> : <Csv text={text} />)}
        {kind === "text" && (err ? <div className="ws-empty">{err}</div>
          : text == null ? <div className="ws-empty">Loading…</div>
          : <pre className="ws-pre">{text}</pre>)}
        {kind === "other" && (
          <div className="ws-empty">
            {asset.contentType || "This file"} cannot be shown here.<br />
            Download it to open it.
          </div>
        )}
      </div>
    </aside>
  );
}
