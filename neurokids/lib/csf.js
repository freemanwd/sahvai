// Non-AI baseline: ventricular CSF by Hounsfield threshold inside the brain,
// keeping central 3D components. Meant as a sanity check next to the AI mask and
// a usable estimate while no validated AI weights are loaded. Not from the paper.
//
// Per axial slice: brain = largest soft-tissue region (-15..100 HU, away from bone),
// holes filled; core = brain minus a 3 mm rim; CSF = core with smoothed HU in [lo, hi].
// Slices whose brain area is < 25% of the largest are skipped. In 3D: 6-connected components; keep the largest central one plus any other
// central component >= 10% of it and >= 0.3 mL.

function smooth3(src, nx, ny, out) {
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, c = 0;
    for (let j = -1; j <= 1; j++) { const yy = y + j; if (yy < 0 || yy >= ny) continue;
      for (let i = -1; i <= 1; i++) { const xx = x + i; if (xx < 0 || xx >= nx) continue; s += src[yy * nx + xx]; c++; } }
    out[y * nx + x] = s / c;
  }
  return out;
}

// Chamfer distance (mm) from each foreground pixel to the nearest background pixel.
function dist(fg, nx, ny, sx, sy, out) {
  const d = Math.hypot(sx, sy), BIG = 1e9;
  for (let i = 0; i < fg.length; i++) out[i] = fg[i] ? BIG : 0;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x; if (!out[i]) continue;
    let v = out[i];
    if (x > 0) v = Math.min(v, out[i - 1] + sx); else v = Math.min(v, sx);
    if (y > 0) { v = Math.min(v, out[i - nx] + sy); if (x > 0) v = Math.min(v, out[i - nx - 1] + d); if (x < nx - 1) v = Math.min(v, out[i - nx + 1] + d); }
    else v = Math.min(v, sy);
    out[i] = v;
  }
  for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
    const i = y * nx + x; if (!out[i]) continue;
    let v = out[i];
    if (x < nx - 1) v = Math.min(v, out[i + 1] + sx); else v = Math.min(v, sx);
    if (y < ny - 1) { v = Math.min(v, out[i + nx] + sy); if (x < nx - 1) v = Math.min(v, out[i + nx + 1] + d); if (x > 0) v = Math.min(v, out[i + nx - 1] + d); }
    else v = Math.min(v, sy);
    out[i] = v;
  }
  return out;
}

// 4-connected 2D labelling; returns [labels, areas].
function label2d(fg, nx, ny, lab) {
  lab.fill(0); const areas = [0], stack = new Int32Array(fg.length);
  for (let s = 0; s < fg.length; s++) {
    if (!fg[s] || lab[s]) continue;
    const id = areas.length; let top = 0, a = 0; stack[top++] = s; lab[s] = id;
    while (top) {
      const p = stack[--top]; a++;
      const x = p % nx, y = (p / nx) | 0;
      if (x > 0 && fg[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[top++] = p - 1; }
      if (x < nx - 1 && fg[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && fg[p - nx] && !lab[p - nx]) { lab[p - nx] = id; stack[top++] = p - nx; }
      if (y < ny - 1 && fg[p + nx] && !lab[p + nx]) { lab[p + nx] = id; stack[top++] = p + nx; }
    }
    areas.push(a);
  }
  return areas;
}

function fillHoles(m, nx, ny, lab) {
  const bg = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) bg[i] = m[i] ? 0 : 1;
  label2d(bg, nx, ny, lab);
  const outside = new Set();
  for (let x = 0; x < nx; x++) { outside.add(lab[x]); outside.add(lab[(ny - 1) * nx + x]); }
  for (let y = 0; y < ny; y++) { outside.add(lab[y * nx]); outside.add(lab[y * nx + nx - 1]); }
  for (let i = 0; i < m.length; i++) if (bg[i] && !outside.has(lab[i])) m[i] = 1;
}

export function csfBaseline(V, { lo = -5, hi = 16, rim = 3, progress = () => {}, log = () => {} } = {}) {
  const t0 = performance.now();
  const { nx, ny, nz, data } = V, [sx, sy, sz] = V.spacing, plane = nx * ny, vox = sx * sy * sz / 1000;
  const cand = new Uint8Array(plane * nz), brain = new Uint8Array(plane * nz);
  const f = new Float32Array(plane), sm = new Float32Array(plane), dd = new Float32Array(plane), lab = new Int32Array(plane);
  const soft = new Uint8Array(plane), seed = new Uint8Array(plane);
  for (let z = 0; z < nz; z++) {
    const o = z * plane;
    for (let i = 0; i < plane; i++) f[i] = data[o + i];
    smooth3(f, nx, ny, sm);
    // bone (raw > 200 HU) grown by one pixel is never soft tissue
    for (let i = 0; i < plane; i++) soft[i] = sm[i] >= -15 && sm[i] <= 100 ? 1 : 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (f[y * nx + x] > 200)
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const yy = y + j, xx = x + i; if (yy >= 0 && yy < ny && xx >= 0 && xx < nx) soft[yy * nx + xx] = 0; }
    // brain = soft tissue reachable from the largest 3 mm-eroded soft component
    dist(soft, nx, ny, sx, sy, dd);
    for (let i = 0; i < plane; i++) seed[i] = dd[i] > rim ? 1 : 0;
    const areas = label2d(seed, nx, ny, lab);
    let best = 0; for (let k = 1; k < areas.length; k++) if (!best || areas[k] > areas[best]) best = k;
    if (!best || areas[best] * sx * sy < 200) { progress((z + 1) / nz); continue; }   // < 2 cm^2: no brain on this slice
    for (let i = 0; i < plane; i++) seed[i] = lab[i] === best ? 0 : 1;   // background of the chosen component
    dist(seed, nx, ny, sx, sy, dd);                                        // distance to the component
    const b = brain.subarray(o, o + plane);
    for (let i = 0; i < plane; i++) b[i] = soft[i] && dd[i] <= rim + 0.01 ? 1 : 0;
    fillHoles(b, nx, ny, lab);
    dist(b, nx, ny, sx, sy, dd);
    for (let i = 0; i < plane; i++) cand[o + i] = b[i] && dd[i] > rim && sm[i] >= lo && sm[i] <= hi ? 1 : 0;
    if (z % 4 === 0) progress(0.8 * (z + 1) / nz);
  }
  // ventricles only sit on slices with a substantial brain cross-section (>= 25% of the largest)
  const barea = new Float64Array(nz);
  for (let z = 0; z < nz; z++) { let c = 0; for (let i = z * plane; i < (z + 1) * plane; i++) c += brain[i]; barea[z] = c; }
  const bmax = Math.max(...barea);
  for (let z = 0; z < nz; z++) if (barea[z] < 0.25 * bmax) { cand.fill(0, z * plane, (z + 1) * plane); brain.fill(0, z * plane, (z + 1) * plane); }
  // brain extent, for "central"
  let x0 = nx, x1 = 0, y0 = ny, y1 = 0, nb = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (brain[z * plane + y * nx + x]) {
    nb++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const out = new Uint8Array(plane * nz);
  if (!nb) { log('CSF baseline: no brain found'); return { mask: out, brainMl: 0 }; }
  const cxm = (x0 + x1) / 2, w = x1 - x0, h = y1 - y0;
  // 3D 6-connected components of candidates (BFS queue doubles as the voxel list)
  let C = 0; for (let i = 0; i < cand.length; i++) C += cand[i];
  const order = new Int32Array(C), comps = [];
  let wpos = 0;
  for (let s = 0; s < cand.length; s++) {
    if (cand[s] !== 1) continue;
    const start = wpos; order[wpos++] = s; cand[s] = 2;
    let r = start, mx = 0, my = 0;
    while (r < wpos) {
      const p = order[r++];
      const z = (p / plane) | 0, rr = p - z * plane, y = (rr / nx) | 0, x = rr - y * nx; mx += x; my += y;
      if (x > 0 && cand[p - 1] === 1) { cand[p - 1] = 2; order[wpos++] = p - 1; }
      if (x < nx - 1 && cand[p + 1] === 1) { cand[p + 1] = 2; order[wpos++] = p + 1; }
      if (y > 0 && cand[p - nx] === 1) { cand[p - nx] = 2; order[wpos++] = p - nx; }
      if (y < ny - 1 && cand[p + nx] === 1) { cand[p + nx] = 2; order[wpos++] = p + nx; }
      if (z > 0 && cand[p - plane] === 1) { cand[p - plane] = 2; order[wpos++] = p - plane; }
      if (z < nz - 1 && cand[p + plane] === 1) { cand[p + plane] = 2; order[wpos++] = p + plane; }
    }
    const n = wpos - start;
    comps.push({ start, end: wpos, n, cx: mx / n, cy: my / n });
  }
  const central = c => Math.abs(c.cx - cxm) < 0.22 * w && c.cy > y0 + 0.15 * h && c.cy < y0 + 0.8 * h;
  const cen = comps.filter(central).sort((a, b) => b.n - a.n);
  let kept = 0;
  for (const c of cen) if (c === cen[0] || (c.n >= 0.1 * cen[0].n && c.n * vox >= 0.3)) { kept++; for (let k = c.start; k < c.end; k++) out[order[k]] = 1; }
  progress(1);
  log(`CSF baseline: ${comps.length} CSF components, kept ${kept} central; ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { mask: out, brainMl: nb * vox };
}
