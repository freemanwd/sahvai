// AI ventricle segmentation, following fast-radiology/hydrocephalus (MIT):
//   open_dcm_image: clip to [-100, 100] HU -> uint8 -> cv2.equalizeHist -> /255
//   2D U-Net per axial slice, argmax over {void, water}
//   postprocess: slice-to-slice consistency along z
// The ONNX model takes image [N,1,512,512] and returns prob [N,1,512,512]
// (see tools/neurokids_model.py BrowserWrapper).

export const SIZE = 512;
const WMIN = -100, WMAX = 100;

// Round half to even, as OpenCV's saturate_cast<uchar>(float) does.
const rint = v => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };

// HU plane -> uint8 after the paper's window and cv2.equalizeHist (bit-exact with OpenCV).
export function windowEqualise(hu, out = new Uint8Array(hu.length)) {
  const n = hu.length, hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    let v = hu[i]; v = v < WMIN ? WMIN : v > WMAX ? WMAX : v;
    const u = Math.trunc((v - WMIN) / (WMAX - WMIN) * 255);
    out[i] = u; hist[u]++;
  }
  let i = 0; while (i < 256 && !hist[i]) i++;
  if (i === 256) return out;
  if (hist[i] === n) { out.fill(i); return out; }
  const lut = new Uint8Array(256), scale = Math.fround(255 / Math.fround(n - hist[i]));
  let sum = 0;
  for (lut[i++] = 0; i < 256; i++) { sum += hist[i]; const v = rint(Math.fround(sum * scale)); lut[i] = v > 255 ? 255 : v; }
  for (let k = 0; k < n; k++) out[k] = lut[out[k]];
  return out;
}

// Bilinear resize with pixel-centre alignment (cv2.INTER_LINEAR / align_corners=False).
export function resize(src, sw, sh, dw, dh, out = new Float32Array(dw * dh)) {
  if (sw === dw && sh === dh) { out.set(src); return out; }
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * fy - 0.5; if (sy < 0) sy = 0;
    const y0 = Math.min(Math.floor(sy), sh - 1), y1 = Math.min(y0 + 1, sh - 1), wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * fx - 0.5; if (sx < 0) sx = 0;
      const x0 = Math.min(Math.floor(sx), sw - 1), x1 = Math.min(x0 + 1, sw - 1), wx = sx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

// Paper postprocess: fill a voxel present above and below, drop one present in neither.
export function postprocess(mask, plane, nz) {
  const m = mask.slice();
  for (let z = 1; z < nz - 1; z++) {
    const o = z * plane;
    for (let i = 0; i < plane; i++) {
      const up = m[o - plane + i], dn = m[o + plane + i];   // already-updated slice below, as in the paper's in-place loop
      let v = m[o + i] | (up & mask[o + plane + i]);
      v &= up | dn;
      m[o + i] = v;
    }
  }
  return m;
}

export async function loadSession(ort, bytes, device, log = () => {}) {
  const ep = device === 'webgpu' ? ['webgpu'] : ['wasm'];
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ep, graphOptimizationLevel: 'all' });
  const inName = s.inputNames[0], outName = s.outputNames[0];
  log(`model session ready on ${device === 'webgpu' ? 'WebGPU' : 'CPU'} (input "${inName}", output "${outName}")`);
  return { s, inName, outName, device };
}

// V: {data Int16 [z][y][x], nx, ny, nz}. Returns Uint8 mask in the same layout.
export async function segment(ort, sess, V, { batch = 2, progress = () => {}, log = () => {}, post = true } = {}) {
  const { nx, ny, nz } = V, plane = nx * ny, S = SIZE * SIZE;
  const mask = new Uint8Array(plane * nz);
  const u8 = new Uint8Array(plane), f = new Float32Array(plane), rs = new Float32Array(S), back = new Float32Array(plane);
  if (nx !== SIZE || ny !== SIZE) log(`slices are ${nx}x${ny}; resized to ${SIZE}x${SIZE} for the model and back`);
  const t0 = performance.now();
  for (let z0 = 0; z0 < nz; z0 += batch) {
    const b = Math.min(batch, nz - z0), input = new Float32Array(b * S);
    for (let j = 0; j < b; j++) {
      windowEqualise(V.data.subarray((z0 + j) * plane, (z0 + j + 1) * plane), u8);
      for (let i = 0; i < plane; i++) f[i] = u8[i];
      resize(f, nx, ny, SIZE, SIZE, rs);
      for (let i = 0; i < S; i++) input[j * S + i] = Math.round(rs[i]) / 255;
    }
    const out = await sess.s.run({ [sess.inName]: new ort.Tensor('float32', input, [b, 1, SIZE, SIZE]) });
    const p = out[sess.outName].data;
    for (let j = 0; j < b; j++) {
      resize(p.subarray(j * S, (j + 1) * S), SIZE, SIZE, nx, ny, back);
      const o = (z0 + j) * plane;
      for (let i = 0; i < plane; i++) mask[o + i] = back[i] > 0.5 ? 1 : 0;
    }
    out[sess.outName].dispose?.();
    progress(Math.min(1, (z0 + b) / nz));
  }
  log(`AI segmentation: ${nz} slices in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return post ? postprocess(mask, plane, nz) : mask;
}
