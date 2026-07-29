"use client";

/**
 * The beats that do not need 3D.
 *
 * Only the machine itself earns a WebGL scene. A request, a shortlist and a
 * refund are interface, and interface is better rendered as interface: real
 * type, real spacing, real numbers. These sit over the same stage and cross
 * fade with the canvas.
 */

/* ------------------------------------------------------------ you ask ----- */
export function SceneAsk({ on }: { on: boolean }) {
  return (
    <div className={`sc sc-ask${on ? " on" : ""}`}
         style={{ opacity: on ? 1 : 0, visibility: on ? "visible" : "hidden" }}>
      <div className="ask-msg">
        <span className="ask-from">you</span>
        <p>
          Cut me out of this clip and put a gradient behind me.
        </p>
        <div className="ask-file">
          <span className="ask-thumb" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ animationDelay: `${i * 90}ms` }} />)}
          </span>
          <span className="ask-meta">
            <b>clip.mp4</b>
            <em>00:10 · 1080p · 14.2 MB</em>
          </span>
        </div>
      </div>
      <div className="ask-cap">
        <span className="ask-dot" /> budget ceiling set to 0.06 <span className="hb">&#8463;</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- it picks one ----- */
const SHORTLIST = [
  { lane: "cpu-4", vram: "no GPU", price: "147,000", note: "too slow for per-frame work" },
  { lane: "gpu-t4", vram: "16 GB", price: "474,000", note: "fits the model, cheapest that does" },
  { lane: "gpu-a100-80", vram: "85 GB", price: "2,296,000", note: "more VRAM than the job needs" },
];

export function ScenePick({ on }: { on: boolean }) {
  return (
    <div className={`sc sc-pick${on ? " on" : ""}`}
         style={{ opacity: on ? 1 : 0, visibility: on ? "visible" : "hidden" }}>
      {SHORTLIST.map((m, i) => (
        <div className={`pk${i === 1 ? " chosen" : ""}`} key={m.lane}>
          {i === 1 && <span className="pk-flag">chosen</span>}
          <span className="pk-lane">{m.lane}</span>
          <span className="pk-vram">{m.vram}</span>
          <span className="pk-price">{m.price}<em> tinybar/s</em></span>
          <span className="pk-note">{m.note}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------- the change back ----- */
export function SceneBack({ on }: { on: boolean }) {
  return (
    <div className={`sc sc-back${on ? " on" : ""}`}
         style={{ opacity: on ? 1 : 0, visibility: on ? "visible" : "hidden" }}>
      <div className="bk-card">
        <div className="bk-top">
          <span>Session closed</span>
          <span className="bk-id">3c145a57</span>
        </div>
        <div className="bk-rows">
          <div><span>Bought</span><b>180s</b></div>
          <div><span>Held</span><b>141s</b></div>
          <div className="bk-hi"><span>Returned</span><b>39s</b></div>
        </div>
        <div className="bk-bar" aria-hidden="true"><i /><u /></div>
      </div>
      <div className="bk-arrow" aria-hidden="true">
        {[0, 1, 2].map((i) => <span key={i} style={{ animationDelay: `${i * 220}ms` }} />)}
      </div>
      <div className="bk-wallet">
        <span className="bk-w-lab">agent wallet</span>
        <span className="bk-w-amt">+0.0117 <span className="hb">&#8463;</span></span>
        <span className="bk-w-sub">refunded on chain</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ the bill on chain -- */
export function SceneBill({ on }: { on: boolean }) {
  return (
    <div className={`sc sc-bill${on ? " on" : ""}`}
         style={{ opacity: on ? 1 : 0, visibility: on ? "visible" : "hidden" }}>
      <div className="bl">
        <div className="bl-head">
          <span className="bl-topic">HIP-991 topic 0.0.9795865</span>
          <span className="bl-live">on chain</span>
        </div>
        <div className="bl-rows">
          <div><span>burn checkpoints</span><b>seq 137 &ndash; 141</b></div>
          <div><span>settlement anchor</span><b>seq 142</b></div>
          <div><span>commits to</span><b>running hash</b></div>
        </div>
        <div className="bl-foot">
          Anyone can recompute this from the public mirror node.
        </div>
      </div>
    </div>
  );
}
