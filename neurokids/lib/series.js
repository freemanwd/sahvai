// Group DICOM files into series, pick the head CT series NeuroKids should use, and
// expose it as a volume whose slices are decoded on demand.
// Adapted from radar-web (jarrelscy/radar-web, CC BY-NC-SA 4.0): selection now prefers
// head/brain soft-tissue series instead of abdominal ones, and the volume carries its origin.
import { pmap } from './source.js';
import { selectHeader, sliceHeader, decodeSlice, nums, tsSupported } from './dicom.js';

export const HEAD = /head|brain|cran|skull|neuro|hydro|vp ?shunt|shunt|ventric/i;
export const BONEK = /bone|sharp|\bH6|\bH7|\bJ70|\bFC3[05]/i;

export function isAxial(iop) {
  const r = nums(iop);
  return r.length < 6 || r.some(isNaN) || Math.abs(r[0] * r[4] - r[1] * r[3]) > 0.8;
}

// Mirrors _scan_series/_pick_series in radar-svc: files in one folder are taken
// as one series when the first, middle and last headers agree; otherwise every
// header in that folder is read.
export async function pickSeries(entries, log = () => {}) {
  const folders = new Map(), series = new Map();
  for (const m of entries) {
    const d = m.name.slice(0, m.name.lastIndexOf('/') + 1);
    if (!folders.has(d)) folders.set(d, []);
    folders.get(d).push(m);
  }
  const add = (h, ms) => { let s = series.get(h.series_uid); if (!s) series.set(h.series_uid, s = { ...h, files: [] }); s.files.push(...ms); };
  log(`${folders.size} folder(s); sampling first/middle/last header in each`);
  let opened = 0, nlog = 0;
  const tags = m => { opened++; return selectHeader(m).catch(() => null); };
  const flog = msg => { if (nlog++ < 40) log(msg); else if (nlog === 41) log('… (more folders not shown)'); };
  await pmap([...folders.values()], async ms => {
    ms.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const samples = [...new Set([ms[0], ms[ms.length >> 1], ms[ms.length - 1]])], hs = await Promise.all(samples.map(tags));
    const k = ms[0].name.lastIndexOf('/'), dn = k > 0 ? ms[0].name.slice(0, k) : '(root)';
    if (hs.every(h => h) && new Set(hs.map(h => h.series_uid)).size === 1) {
      add(hs[0], ms);
      flog(`  ${dn}: ${ms.length} files -> one series "${hs[0].desc || '?'}" [${hs[0].body_part || '-'}] (${samples.length} headers read)`);
      return;
    }
    if (hs.every(h => !h) && ms.length > 3) { flog(`  ${dn}: ${ms.length} files, samples not DICOM -> skipped`); return; }
    const hh = await pmap(ms, tags); hh.forEach((h, i) => h && add(h, [ms[i]]));
    flog(`  ${dn}: ${ms.length} files, mixed series -> read all headers, ${new Set(hh.filter(Boolean).map(h => h.series_uid)).size} series`);
  }, 4);
  const all = [...series.values()];
  if (!all.length) throw new Error('no DICOM series found');
  const minSlices = Math.min(16, Math.max(...all.map(s => s.files.length)));
  const usable = s => ['CT', ''].includes(s.modality ?? 'CT') && !/LOCALIZER/i.test(s.image_type || '') && s.files.length >= minSlices;
  log(`found ${all.length} series; read ${opened} headers for ${entries.length} files:`);
  for (const s of [...all].sort((a, b) => b.files.length - a.files.length).slice(0, 30)) {
    const why = [];
    if (!['CT', ''].includes(s.modality ?? 'CT')) why.push('not CT: ' + s.modality);
    if (/LOCALIZER/i.test(s.image_type || '')) why.push('localizer');
    if (s.files.length < minSlices) why.push(`<${minSlices} slices`);
    if (BONEK.test(s.desc || '')) why.push('bone kernel');
    if (!isAxial(s.iop)) why.push('not axial');
    const ab = HEAD.test(s.desc || '') || HEAD.test(s.body_part || '');
    log(`  ${String(s.files.length).padStart(5)} slices  ${s.modality || '?'}  "${s.desc || ''}" [${s.body_part || '-'}]${ab ? '  HEAD' : ''}${why.length ? '  (' + why.join(', ') + ')' : ''}`);
  }
  const cands = all.filter(usable).length ? all.filter(usable) : all;
  const head = cands.filter(s => HEAD.test(s.desc || '') || HEAD.test(s.body_part || ''));
  const soft = (head.length ? head : cands).filter(s => !BONEK.test(s.desc || ''));
  const pool = soft.length ? soft : head.length ? head : cands;
  const best = pool.reduce((a, b) => {
    const ka = [isAxial(a.iop), a.files.length], kb = [isAxial(b.iop), b.files.length];
    return (kb[0] > ka[0] || (kb[0] === ka[0] && kb[1] > ka[1])) ? b : a;
  });
  const why = head.length ? 'largest axial head series (soft-tissue kernel preferred)' : 'no series labelled head/brain; used largest axial CT series';
  log(`picked "${best.desc || '?'}" (${best.files.length} slices): ${why}`);
  return {
    best, why, opened,
    list: all.sort((a, b) => b.files.length - a.files.length).map(s => ({ description: s.desc || '', body_part: s.body_part || '', num_slices: s.files.length })),
  };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Volume in DICOM index order: axis0 = column (along a row), axis1 = row,
// axis2 = slice sorted along the normal, like SimpleITK's ImageSeriesReader.
// dir[a] is the LPS direction of axis a.
export async function seriesVolume(files, log = () => {}) {
  const t0 = performance.now();
  let hs = await pmap(files, async m => ({ m, h: await sliceHeader(m).catch(() => null) }), 16);
  hs = hs.filter(x => x.h && x.h.rows && x.h.cols);
  const empty = hs.filter(x => x.h.no_pixels).length;
  if (empty) {
    hs = hs.filter(x => !x.h.no_pixels);
    log(`skipped ${empty} of ${empty + hs.length} files that have a header but no pixel data`);
    if (!hs.length) throw new Error(`the ${empty} files in the selected series have DICOM headers but no pixel data. The export may have saved headers only; try exporting the study again with images`);
  }
  if (!hs.length) throw new Error('selected series has no readable images');
  if ((hs[0]?.h.frames | 0) > 1) throw new Error('multi-frame (enhanced) DICOM is not supported yet');
  // keep the most common in-plane size
  const key = x => `${x.h.rows}x${x.h.cols}`, cnt = new Map();
  for (const x of hs) cnt.set(key(x), (cnt.get(key(x)) || 0) + 1);
  const size = [...cnt].sort((a, b) => b[1] - a[1])[0][0];
  hs = hs.filter(x => key(x) === size);
  const h0 = hs[0].h;
  if (!tsSupported(h0.ts)) throw new Error(`transfer syntax ${h0.ts} not supported`);
  let iop = nums(h0.iop); if (iop.length < 6 || iop.some(isNaN)) iop = [1, 0, 0, 0, 1, 0];
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
  const havePos = hs.every(x => nums(x.h.ipp).length === 3);
  for (const x of hs) x.z = havePos ? dot(nums(x.h.ipp), normal) : Number(x.h.instance) || 0;
  hs.sort((a, b) => a.z - b.z || (Number(a.h.instance) || 0) - (Number(b.h.instance) || 0));
  const n = hs.length, ps = nums(h0.spacing);
  let dz = n > 1 ? Math.abs(hs[n - 1].z - hs[0].z) / (n - 1) : 1;
  if (!havePos || !(dz > 0)) dz = Number(h0.thickness) || 1;
  const spacing = [ps[1] || 1, ps[0] || 1, dz];
  log(`series geometry: ${h0.cols}x${h0.rows}x${n}, spacing ${spacing.map(s => s.toFixed(3)).join(', ')} mm, ` +
      `transfer syntax ${h0.ts || 'implicit'} (${((performance.now() - t0) / 1000).toFixed(1)}s for ${files.length} headers)`);
  const ipp0 = nums(hs[0].h.ipp), origin = ipp0.length === 3 && !ipp0.some(isNaN) ? ipp0 : [0, 0, 0];
  return {
    dims: [h0.cols, h0.rows, n], spacing, dir: [rowDir, colDir, normal], origin,
    age: h0.age || '', desc: h0.desc || '',
    slice: k => decodeSlice(hs[k].m, hs[k].h),
  };
}
