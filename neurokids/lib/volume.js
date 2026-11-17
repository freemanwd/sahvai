// Load a whole volume (from series.js or nifti.js) into memory, reoriented so that
//   x runs towards the patient's Left, y towards Posterior, z towards Superior (LPS),
// which is the usual radiological axial display: patient right on screen left,
// anterior at the top, slice 0 lowest. HU are stored as Int16.

export function orient(vol) {
  // out axis a (0=L, 1=P, 2=S) <- source axis perm[a], reversed if flip[a]
  const perm = [-1, -1, -1];
  const order = [0, 1, 2].sort((p, q) => Math.max(...vol.dir[q].map(Math.abs)) - Math.max(...vol.dir[p].map(Math.abs)));
  for (const s of order) {
    let best = -1;
    for (let a = 0; a < 3; a++) if (perm[a] < 0 && (best < 0 || Math.abs(vol.dir[s][a]) > Math.abs(vol.dir[s][best]))) best = a;
    perm[best] = s;
  }
  const flip = perm.map((s, a) => (vol.dir[s][a] || 1) < 0);
  return { perm, flip };
}

export async function loadVolume(vol, progress = () => {}) {
  const { perm, flip } = orient(vol);
  const [n0, n1, n2] = vol.dims, plane = n0 * n1;
  const src = new Int16Array(plane * n2);
  for (let k = 0; k < n2; k++) {
    const s = await vol.slice(k);
    for (let i = 0; i < plane; i++) { const v = Math.round(s[i]); src[k * plane + i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v; }
    if (k % 4 === 0) progress((k + 1) / n2);
  }
  const nx = vol.dims[perm[0]], ny = vol.dims[perm[1]], nz = vol.dims[perm[2]];
  const stride = [1, n0, plane];
  const sx = stride[perm[0]], sy = stride[perm[1]], sz = stride[perm[2]];
  const ox = flip[0] ? (nx - 1) * sx : 0, oy = flip[1] ? (ny - 1) * sy : 0, oz = flip[2] ? (nz - 1) * sz : 0;
  const dx = flip[0] ? -sx : sx, dy = flip[1] ? -sy : sy, dz = flip[2] ? -sz : sz;
  const identity = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip.some(Boolean);
  let data = src;
  if (!identity) {
    data = new Int16Array(nx * ny * nz);
    let o = 0;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      let p = oz + z * dz + oy + y * dy + ox;
      for (let x = 0; x < nx; x++, p += dx) data[o++] = src[p];
    }
  }
  const spacing = perm.map(s => vol.spacing[s]);
  // LPS position of output voxel (0,0,0): the source corner that maps to it
  const origin = [...(vol.origin || [0, 0, 0])];
  perm.forEach((s, a) => { if (flip[a]) for (let c = 0; c < 3; c++) origin[c] += (vol.dims[s] - 1) * vol.spacing[s] * vol.dir[s][c]; });
  const oblique = perm.map((s, a) => Math.abs(vol.dir[s][a])).some(c => c < 0.98);
  return { data, nx, ny, nz, spacing, origin, oblique, perm, flip };
}
