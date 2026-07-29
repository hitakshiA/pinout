"use client";

/**
 * The whole rental, played out left to right, with a real graphics card in the
 * middle of it.
 *
 * Five beats: the human asks, the agent picks a machine and pays over x402, the
 * card spins up and does the work, it runs dry and waits, then it is released
 * and the change comes back. The card is Three.js, built from primitives in
 * gpu-model.ts, and its fans and light strip are driven by the beat so the 3D
 * is reporting state rather than decorating the section.
 *
 * Numbers are from session 3c145a57: 120 seconds bought, exhausted, 60 topped
 * up, 141 billed, 39 refunded, verified against the mirror node.
 */

import { useEffect, useRef, useState } from "react";
// type-only: three is dynamically imported below, so this adds nothing to the bundle
import { SceneAsk, ScenePick, SceneBack, SceneBill } from "./scenes";

type Beat = {
  key: string;
  who: "you" | "agent" | "chain";
  title: string;
  body: string;
  stat?: string;
  ms: number;
};

const BEATS: Beat[] = [
  { key: "ask", who: "you", title: "You ask", ms: 3000,
    body: "A job and a spending ceiling. Nothing about which machine to use.",
    stat: "budget 0.06 ℏ" },
  { key: "pick", who: "agent", title: "It picks the machine", ms: 3200,
    body: "Reads the catalogue, matches the job to a lane, and signs one x402 payment.",
    stat: "120s bought · 0.0360 ℏ" },
  { key: "work", who: "agent", title: "The card runs", ms: 3600,
    body: "Seconds are checkpointed to a Hedera topic as the work happens.",
    stat: "seq 137 → 140" },
  { key: "dry", who: "chain", title: "It runs dry", ms: 3200,
    body: "Credits reach zero. The machine is held and the meter stops.",
    stat: "0 billed while held" },
  { key: "topup", who: "agent", title: "It tops up", ms: 3000,
    body: "A second x402 payment, and the same process carries on from where it stopped.",
    stat: "+60s · 0.0180 ℏ" },
  { key: "done", who: "agent", title: "Work finishes", ms: 3000,
    body: "The job completes and the machine is handed straight back.",
    stat: "141s held in total" },
  { key: "back", who: "chain", title: "Hedera refunds the rest", ms: 3400,
    body: "Seconds bought but never used return to the agent's wallet on chain.",
    stat: "39s · 0.0117 ℏ back" },
  { key: "bill", who: "chain", title: "The bill is on chain", ms: 3600,
    body: "Settlement anchors to a HIP-991 topic that anyone can recompute from the mirror node.",
    stat: "anchor seq 142" },
];

const SPEND_BY_KEY: Record<string, [number, number] | null> = {
  ask: null, pick: [0, 0], work: [0, 0.0360], dry: [0.0360, 0.0360],
  topup: [0.0360, 0.0360], done: [0.0360, 0.0423], back: [0.0423, 0.0423],
  bill: [0.0423, 0.0423],
};

export default function RentFlow() {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [i, setI] = useState(0);
  const [live, setLive] = useState(false);
  const beat = useRef(0);

  // the counter eases between the beat's start and end value
  const [spend, setSpend] = useState(0);
  useEffect(() => {
    const range = SPEND_BY_KEY[BEATS[i].key];
    if (!range) return;
    const [from, to] = range;
    if (from === to) { setSpend(to); return; }
    const t0 = performance.now(), dur = BEATS[i].ms * 0.82;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setSpend(from + (to - from) * k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [i]);

  // advance the story
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => {
      beat.current = (beat.current + 1) % BEATS.length;
      setI(beat.current);
    }, BEATS[i].ms);
    return () => clearTimeout(t);
  }, [i, live]);

  // start only once it is on screen
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => setLive(e.isIntersecting)),
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // three.js: lazy, paused when off screen, and skipped entirely for reduced motion
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let stop = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      const { buildGPU } = await import("./gpu-model");

      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      cam.position.set(0.05, 0.16, 4.3);
      cam.lookAt(0, 0.02, 0);

      const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

      const { card, fans, stripMat } = buildGPU();
      scene.add(card);

      scene.add(new THREE.AmbientLight(0x8878b8, 0.75));
      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(3, 4, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x8259ef, 2.2);
      rim.position.set(-4, -1, -2);
      scene.add(rim);
      const warm = new THREE.PointLight(0xffb27a, 0, 6);
      warm.position.set(0, 0, 2);
      scene.add(warm);

      const size = () => {
        const r = el.getBoundingClientRect();
        renderer.setSize(r.width, r.height, false);
        cam.aspect = r.width / Math.max(1, r.height);
        cam.updateProjectionMatrix();
      };
      size();
      const ro = new ResizeObserver(size);
      ro.observe(el);

      let spin = 0, glow = 0.1, tilt = 0;
      const frame = () => {
        if (stop) return;
        const b = BEATS[beat.current].key;

        // fans track the beat: idle, spinning up, flat out, coasting to a stop
        const target = b === "work" || b === "done" ? 0.42 : b === "topup" ? 0.3
          : b === "dry" ? 0.015 : 0.008;
        spin += (target - spin) * 0.045;
        fans.forEach((f, n) => { f.rotation.z += spin * (n ? 1 : -1); });

        // the light strip says what the session is doing
        const wantGlow = b === "work" || b === "done" ? 1.5 : b === "topup" ? 1.1
          : b === "dry" ? 0.35 : 0.1;
        glow += (wantGlow - glow) * 0.06;
        stripMat.emissiveIntensity = glow;
        stripMat.emissive.setHex(b === "dry" ? 0xffb27a : b === "done" ? 0x7fee64 : 0x8259ef);
        warm.intensity = b === "dry" ? 0.9 : 0;

        // eases toward the viewer while it is actually working
        const wantTilt = b === "work" || b === "done" ? 0.34 : b === "dry" ? 0.1 : 0.2;
        tilt += (wantTilt - tilt) * 0.03;
        card.rotation.y = Math.sin(Date.now() / 2600) * 0.16 + tilt;
        card.rotation.x = -0.14 + Math.sin(Date.now() / 3400) * 0.03;
        card.position.y = Math.sin(Date.now() / 1900) * 0.03;

        renderer.render(scene, cam);
        requestAnimationFrame(frame);
      };

      if (reduce) { stripMat.emissiveIntensity = 0.6; renderer.render(scene, cam); }
      else frame();

      cleanup = () => { stop = true; ro.disconnect(); renderer.dispose(); };
    })();

    return () => { stop = true; cleanup(); };
  }, []);

  const b = BEATS[i];

  // running spend, in HBAR, at each beat. it climbs while the card works,
  // freezes while the machine is held, and settles once the job is done.
  const SPEND: Record<string, [number, number] | null> = {
    ask: null,
    pick:  [0, 0],
    work:  [0, 0.0360],
    dry:   [0.0360, 0.0360],
    topup: [0.0360, 0.0360],
    done:  [0.0360, 0.0423],
    back:  [0.0423, 0.0423],
    bill:  [0.0423, 0.0423],
  };
  const span = SPEND[b.key];

  return (
    <div className="flow" ref={host}>
      <div className="flow-stage">
        <canvas ref={canvas}
                className={`flow-canvas${["work","dry","topup","done"].includes(b.key) ? " on" : ""}`}
                aria-hidden="true" />
        {span && (
          <div className={`spend s-${b.key}`}>
            <span className="spend-lab">billed so far</span>
            <span className="spend-val">
              {spend.toFixed(4)} <span className="hb">&#8463;</span>
            </span>
            {b.key === "dry" && <span className="spend-note">meter stopped</span>}
            {b.key === "topup" && <span className="spend-note up">+0.0180 &#8463; added</span>}
            {(b.key === "back" || b.key === "bill") && (
              <span className="spend-note back">0.0117 &#8463; refunded</span>
            )}
          </div>
        )}
        <SceneAsk on={b.key === "ask"} />
        <ScenePick on={b.key === "pick"} />
        <SceneBack on={b.key === "back"} />
        <SceneBill on={b.key === "bill"} />
      </div>

      <ol className="flow-track" style={{ ["--i" as string]: i }}>
        {BEATS.map((x, n) => (
          <li key={x.key} className={`fb${n === i ? " on" : ""}${n < i ? " past" : ""}`}>
            <span className={`fb-who w-${x.who}`}>
              {x.who === "you" ? "You" : x.who === "agent" ? "Agent" : "Hedera"}
            </span>
            <h3>{x.title}</h3>
            <p>{x.body}</p>
          </li>
        ))}
      </ol>

      <div className="flow-rail" aria-hidden="true">
        {BEATS.map((x, n) => (
          <button key={x.key} className={`fdot${n === i ? " on" : ""}`}
                  onClick={() => { beat.current = n; setI(n); }}
                  aria-label={x.title} />
        ))}
      </div>
    </div>
  );
}
