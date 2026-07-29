import * as THREE from "three";

/**
 * Props for the rental sequence, built from primitives rather than loaded from
 * GLTF files. No external requests, no licence questions, and the geometry can
 * be driven directly by session state.
 *
 * Each beat gets its own subject: a prompt card when you ask, a rack of options
 * while it chooses, the graphics card while it works and while it waits, and
 * coins returning at the end.
 */

const M = {
  dark:   () => new THREE.MeshStandardMaterial({ color: 0x0e0e14, roughness: 0.58, metalness: 0.55 }),
  shroud: () => new THREE.MeshStandardMaterial({ color: 0x1b1b25, roughness: 0.42, metalness: 0.74 }),
  pcb:    () => new THREE.MeshStandardMaterial({ color: 0x0a1710, roughness: 0.88, metalness: 0.08 }),
  metal:  () => new THREE.MeshStandardMaterial({ color: 0x36364400, roughness: 0.28, metalness: 0.95 }),
  steel:  () => new THREE.MeshStandardMaterial({ color: 0x363644, roughness: 0.28, metalness: 0.95 }),
  gold:   () => new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.26, metalness: 1 }),
  blade:  () => new THREE.MeshStandardMaterial({ color: 0x1c1c26, roughness: 0.4, metalness: 0.45 }),
  well:   () => new THREE.MeshStandardMaterial({ color: 0x040406, roughness: 0.96, metalness: 0 }),
  chip:   () => new THREE.MeshStandardMaterial({ color: 0x14141b, roughness: 0.7, metalness: 0.3 }),
};

/* ---------------------------------------------------------------- the card -- */
export function buildGPU() {
  const card = new THREE.Group();
  const dark = M.dark(), shroud = M.shroud(), pcbM = M.pcb(), steel = M.steel();
  const gold = M.gold(), bladeM = M.blade(), wellM = M.well(), chipM = M.chip();
  // lighter than the shroud so the blades separate from the well behind them
  const bladeLit = new THREE.MeshStandardMaterial({
    color: 0x4a4a60, roughness: 0.3, metalness: 0.55, side: THREE.DoubleSide });

  // taller than the first pass: fans were nearly touching the top and bottom edges
  const L = 3.1, H = 1.42, D = 0.38;
  const FAN_R = 0.40, FAN_X = 0.74;

  const board = new THREE.Mesh(new THREE.BoxGeometry(L - 0.06, H - 0.04, 0.05), pcbM);
  board.position.z = -D / 2 - 0.02;
  card.add(board);

  // surface-mount components on the exposed board edge
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.06 + Math.random() * 0.05, 0.05, 0.03), chipM);
    c.position.set(-1.3 + i * 0.19, -H / 2 + 0.12, -D / 2 - 0.06);
    card.add(c);
  }

  // gold PCIe fingers, with the short/long split real cards have
  for (let i = 0; i < 20; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(i === 4 ? 0.13 : 0.05, 0.14, 0.018), gold);
    f.position.set(-0.92 + i * 0.075, -H / 2 - 0.06, -D / 2 - 0.02);
    card.add(f);
  }

  const body = new THREE.Mesh(new THREE.BoxGeometry(L, H, D), dark);
  card.add(body);
  const face = new THREE.Mesh(new THREE.BoxGeometry(L - 0.1, H - 0.12, 0.06), shroud);
  face.position.z = D / 2 + 0.01;
  card.add(face);

  // angled vent slots across the centre spine, between the fans
  for (let i = 0; i < 7; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.34, 0.02), wellM);
    slot.position.set(-0.06 + i * 0.021 - 0.06, 0, D / 2 + 0.05);
    slot.rotation.z = 0.32;
    card.add(slot);
  }

  // corner screws
  for (const [sx, sy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.02, 12), steel);
    screw.rotation.x = Math.PI / 2;
    screw.position.set(sx * (L / 2 - 0.11), sy * (H / 2 - 0.11), D / 2 + 0.05);
    card.add(screw);
  }

  // heatsink fins along the top edge
  for (let i = 0; i < 44; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.17, D - 0.06), steel);
    fin.position.set(-1.45 + i * 0.067, H / 2 + 0.07, -0.02);
    card.add(fin);
  }

  const back = new THREE.Mesh(new THREE.BoxGeometry(L - 0.08, H - 0.06, 0.025), steel);
  back.position.z = -D / 2 - 0.06;
  card.add(back);

  const fans: THREE.Group[] = [];
  for (const x of [-FAN_X, FAN_X]) {
    const wellMesh = new THREE.Mesh(new THREE.CircleGeometry(FAN_R, 48), wellM);
    wellMesh.position.set(x, 0, D / 2 + 0.005);
    card.add(wellMesh);

    // heatsink fins sunk inside the well. without something behind them the
    // blades read as one solid disc rather than a fan you can see through.
    const innerFin = new THREE.MeshStandardMaterial({
      color: 0x14141c, roughness: 0.7, metalness: 0.5 });
    for (let f = 0; f < 8; f++) {
      const px = -FAN_R + 0.07 + f * 0.095;
      const half = Math.sqrt(Math.max(0, FAN_R * FAN_R - px * px));
      if (half < 0.05) continue;
      const inner = new THREE.Mesh(new THREE.BoxGeometry(0.01, half * 2 - 0.04, 0.1), innerFin);
      inner.position.set(x + px, 0, D / 2 + 0.03);
      card.add(inner);
    }

    const rim = new THREE.Mesh(new THREE.TorusGeometry(FAN_R, 0.02, 10, 48), shroud);
    rim.position.set(x, 0, D / 2 + 0.05);
    card.add(rim);

    // four struts holding the hub, like a real fan cage
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2 + 0.4;
      const strut = new THREE.Mesh(new THREE.BoxGeometry(FAN_R, 0.018, 0.014), shroud);
      strut.position.set(x + Math.cos(a) * FAN_R / 2, Math.sin(a) * FAN_R / 2, D / 2 + 0.015);
      strut.rotation.z = a;
      card.add(strut);
    }

    const fan = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.05, 24), bladeM);
    hub.rotation.x = Math.PI / 2;
    fan.add(hub);
    // seven narrow blades, not eleven wide ones: the gaps have to be wider than
    // the blades or the fan reads as a solid plate
    const N = 7;
    for (let b = 0; b < N; b++) {
      const a = (b / N) * Math.PI * 2;
      const vane = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.062, 0.009), bladeLit);
      vane.position.set(Math.cos(a) * 0.245, Math.sin(a) * 0.245, 0);
      vane.rotation.z = a;
      vane.rotation.x = 0.72;
      fan.add(vane);
    }
    fan.position.set(x, 0, D / 2 + 0.075);
    card.add(fan);
    fans.push(fan);
  }

  const power = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.15, 0.14), shroud);
  power.position.set(1.16, H / 2 + 0.13, 0);
  card.add(power);

  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x8259ef, emissive: 0x8259ef, emissiveIntensity: 0.1, roughness: 0.35,
  });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(L - 0.55, 0.032, 0.05), stripMat);
  strip.position.set(-0.12, H / 2 - 0.05, D / 2 + 0.05);
  card.add(strip);

  card.scale.setScalar(0.95);
  return { card, fans, stripMat };
}

/* ------------------------------------------------------------ the request -- */
/** A prompt sitting in front of you: a panel with text lines and a clip strip. */
export function buildPrompt() {
  const g = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.5, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x14141d, roughness: 0.6, metalness: 0.3 }));
  g.add(panel);

  const lineMat = new THREE.MeshStandardMaterial({
    color: 0x9c8ec9, emissive: 0x6b5aa8, emissiveIntensity: 0.35, roughness: 0.6 });
  [1.55, 1.85, 1.1].forEach((w, i) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(w, 0.075, 0.02), lineMat);
    l.position.set(-(2.5 - w) / 2 + 0.22, 0.28 - i * 0.24, 0.05);
    g.add(l);
  });

  // the ten second clip, as filmstrip frames
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x8259ef, emissive: 0x8259ef, emissiveIntensity: 0.5, roughness: 0.4 });
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), frameMat);
    f.position.set(-0.92 + i * 0.36, -0.44, 0.05);
    g.add(f);
  }
  return g;
}

/* ------------------------------------------------------------- the choice -- */
/** Three machine options, the middle one picked. */
export function buildOptions() {
  const g = new THREE.Group();
  const picked: THREE.Mesh[] = [];
  const base = new THREE.MeshStandardMaterial({ color: 0x13131b, roughness: 0.62, metalness: 0.35 });
  const on = new THREE.MeshStandardMaterial({
    color: 0x1d1730, emissive: 0x8259ef, emissiveIntensity: 0.42, roughness: 0.45, metalness: 0.4 });

  [-1.35, 0, 1.35].forEach((x, i) => {
    const isPick = i === 1;
    const cardMesh = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.42, 0.09), isPick ? on : base);
    cardMesh.position.set(x, isPick ? 0.06 : 0, isPick ? 0.14 : 0);
    g.add(cardMesh);
    if (isPick) picked.push(cardMesh);

    const barMat = new THREE.MeshStandardMaterial({
      color: isPick ? 0xa98bff : 0x3a3a48,
      emissive: isPick ? 0x8259ef : 0x000000, emissiveIntensity: isPick ? 0.6 : 0, roughness: 0.5 });
    for (let r = 0; r < 3; r++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.62 - r * 0.13, 0.06, 0.02), barMat);
      bar.position.set(x - 0.1, (isPick ? 0.06 : 0) + 0.32 - r * 0.2, (isPick ? 0.14 : 0) + 0.06);
      g.add(bar);
    }
  });
  return { group: g, picked };
}

/* -------------------------------------------------------------- the change -- */
/** HBAR coins heading back to the wallet. */
export function buildCoins() {
  const g = new THREE.Group();
  const coins: THREE.Mesh[] = [];
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7fee64, emissive: 0x2f6b2f, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.85 });
  for (let i = 0; i < 9; i++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.045, 30), mat);
    c.rotation.x = Math.PI / 2;
    c.position.set(-1.7 + i * 0.42, Math.sin(i * 1.3) * 0.3, Math.cos(i) * 0.2);
    g.add(c);
    coins.push(c);
  }
  // the wallet they land in. the first version was an unlit box that read as a
  // hole punched in the scene, so it gets a lit face and a visible slot.
  const shell = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.68, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x232330, roughness: 0.4, metalness: 0.72 }));
  shell.position.set(2.15, 0, 0);
  g.add(shell);
  const faceP = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.56, 0.05),
    new THREE.MeshStandardMaterial({
      color: 0x2c2c3d, emissive: 0x7fee64, emissiveIntensity: 0.14, roughness: 0.35, metalness: 0.6 }));
  faceP.position.set(2.15, 0, 0.15);
  g.add(faceP);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.07, 0.03),
    new THREE.MeshStandardMaterial({
      color: 0x7fee64, emissive: 0x7fee64, emissiveIntensity: 0.9, roughness: 0.4 }));
  slot.position.set(2.15, 0.16, 0.19);
  g.add(slot);
  return { group: g, coins };
}
