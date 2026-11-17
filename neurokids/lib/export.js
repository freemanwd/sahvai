// Downloads: NIfTI-1 (.nii.gz) for the CT and masks in one shared grid, and CSV.
// Volumes are LPS-ordered (x->L, y->P, z->S); NIfTI stores RAS, so x and y are negated.

export async function niftiGz(arr, V, desc = '') {
  const { nx, ny, nz, spacing: [sx, sy, sz], origin: [ox, oy, oz] } = V;
  const dt = arr instanceof Int16Array ? [4, 16] : [2, 8];   // [datatype, bitpix]
  const hdr = new ArrayBuffer(352), dv = new DataView(hdr);
  dv.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((v, i) => dv.setInt16(40 + 2 * i, v, true));
  dv.setInt16(70, dt[0], true); dv.setInt16(72, dt[1], true);
  [1, sx, sy, sz, 0, 0, 0, 0].forEach((v, i) => dv.setFloat32(76 + 4 * i, v, true));
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true); dv.setFloat32(116, 0, true);
  dv.setUint8(123, 2);                                   // xyzt_units: mm
  const d = new TextEncoder().encode(desc.slice(0, 79)); new Uint8Array(hdr, 148, 80).set(d);
  dv.setInt16(252, 1, true); dv.setInt16(254, 1, true);  // qform and sform: scanner
  // quaternion for diag(-1,-1,1): b=c=0, d=1 (180 deg about z)
  dv.setFloat32(256, 0, true); dv.setFloat32(260, 0, true); dv.setFloat32(264, 1, true);
  dv.setFloat32(268, -ox, true); dv.setFloat32(272, -oy, true); dv.setFloat32(276, oz, true);
  [[-sx, 0, 0, -ox], [0, -sy, 0, -oy], [0, 0, sz, oz]].forEach((row, r) => row.forEach((v, c) => dv.setFloat32(280 + 16 * r + 4 * c, v, true)));
  new Uint8Array(hdr, 344, 4).set([0x6e, 0x2b, 0x31, 0]);  // "n+1\0"
  const body = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  const gz = new Blob([hdr, body]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(gz).blob();
}

export function sliceCsv(V, masks) {
  const { nx, ny, nz, spacing: [sx, sy, sz] } = V, plane = nx * ny, names = Object.keys(masks);
  const rows = [['slice_index', 'z_mm', ...names.map(n => `${n}_area_mm2`)]];
  for (let z = 0; z < nz; z++) {
    const r = [z, (V.origin[2] + z * sz).toFixed(2)];
    for (const n of names) { let c = 0; const m = masks[n], o = z * plane; for (let i = 0; i < plane; i++) c += m[o + i]; r.push((c * sx * sy).toFixed(1)); }
    rows.push(r);
  }
  return new Blob([rows.map(r => r.join(',')).join('\n') + '\n'], { type: 'text/csv' });
}

export function save(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
