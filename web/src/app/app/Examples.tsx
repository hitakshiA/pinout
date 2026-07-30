"use client";

/**
 * The empty workspace.
 *
 * An agent that rents its own compute is an unfamiliar enough idea that a blank
 * box and a blinking cursor is a bad first screen: it asks the visitor to guess
 * both what to say and what the thing is for. These three examples answer both
 * at once, and each one carries its file, so a person can watch a GPU get
 * rented and paid for without having to find a video first.
 */

export type Example = {
  key: string;
  label: string;
  file: string;          // served from /samples
  mime: string;
  prompt: string;
  icon: React.ReactNode;
};

const Film = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5" />
  </svg>
);
const People = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const Table = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18" />
  </svg>
);

/* Each one is a real job on real hardware, and each picks a different lane, so
   three clicks show the whole range: a GPU that has to think, a GPU that has to
   look, and a CPU that only has to count. */
export const EXAMPLES: Example[] = [
  {
    key: "bg",
    label: "Cut me out of this video and put a gradient behind me",
    file: "person.mp4",
    mime: "video/mp4",
    prompt:
      "Remove the background from this video, put a gradient behind them, and " +
      "deliver the result as an mp4.",
    icon: Film,
  },
  {
    key: "track",
    label: "Count the people in this street footage",
    file: "crowd.mp4",
    mime: "video/mp4",
    prompt:
      "Count and track the people in this footage on a GPU lane, draw boxes " +
      "with track ids, and deliver an annotated mp4. Tell me how many distinct " +
      "people you counted.",
    icon: People,
  },
  {
    key: "clean",
    label: "Clean this messy sensor data and summarise it",
    file: "sensors.csv",
    mime: "text/csv",
    prompt:
      "Clean this sensor data on the cheapest CPU lane that can do it: drop " +
      "duplicates and rows with a blank reading, lowercase the quality column " +
      "and drop the bad ones, and normalise every timestamp to unix seconds. " +
      "Then compute per-sensor summary statistics from the cleaned file. " +
      "Deliver both CSVs and tell me how many rows survived.",
    icon: Table,
  },
];

export function Examples({
  onPick, busy,
}: { onPick: (e: Example) => void; busy: boolean }) {
  return (
    <div className="ws-home">
      <h1 className="ws-greet">What should the agent build?</h1>
      <p className="ws-greet-sub">
        It rents its own compute, pays for it on Hedera, and gives back what it
        does not spend. Start from an example, or describe your own job below.
      </p>

      <div className="ws-ideas-label">Try one</div>
      <div className="ws-ideas">
        {EXAMPLES.map((e) => (
          <button key={e.key} className="ws-idea" disabled={busy}
                  onClick={() => onPick(e)}>
            <span className="ws-idea-icon">{e.icon}</span>
            <span className="ws-idea-text">{e.label}</span>
            <span className="ws-idea-file">{e.file}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Fetch a sample as a File, the same thing a file picker hands over.
 *
 * It used to come back as base64 and get uploaded on the spot, which meant an
 * example silently skipped the attachment UI: no chip in the composer, nothing
 * to remove, and a prompt referring to a video with no video in sight. Handing
 * back a File puts examples on the ordinary path instead of beside it.
 */
export async function loadSample(file: string, mime: string): Promise<File> {
  const res = await fetch(`/samples/${file}`);
  if (!res.ok) throw new Error(`could not load ${file}`);
  return new File([await res.blob()], file, { type: mime });
}
