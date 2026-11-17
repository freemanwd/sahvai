// NeuroKids pipeline, off the main thread.
// In:  {type:'run', files, device, methods:{ai, csf}, model:{url}|{bytes, name}}
// Out: {type:'log'|'progress'|'error'|'result', ...}
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { openInput } from './lib/source.js';
import { pickSeries, seriesVolume } from './lib/series.js';
import { niftiVolume } from './lib/nifti.js';
import { loadVolume } from './lib/volume.js';
import { loadSession, segment } from './lib/hydro.js';
import { csfBaseline } from './lib/csf.js';

const base = new URL('./', import.meta.url).href;
ort.env.wasm.wasmPaths = base + 'vendor/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 16) : 1;
ort.env.logLevel = 'error';

const post = (type, x = {}, tr) => self.postMessage({ type, ...x }, tr || []);
const log = msg => post('log', { msg });
const stage = (name, frac) => post('progress', { stage: name, frac });
log(`cross-origin isolated: ${self.crossOriginIsolated}; CPU threads: ${ort.env.wasm.numThreads}`);

const CACHE = 'neurokids-models-v1';
async function fetchModel(url) {
  const abs = new URL(url, base).href, cache = self.caches ? await caches.open(CACHE) : null;
  let r = cache && await cache.match(abs);
  if (r) { log(`model ${url} from browser cache`); return new Uint8Array(await r.arrayBuffer()); }
  r = await fetch(abs);
  if (!r.ok) throw new Error(`could not download model ${url} (${r.status})`);
  const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    parts.push(value); got += value.length;
    stage(`Downloading model · ${(got / 1e6).toFixed(1)} MB`, total ? got / total : 0);
  }
  const blob = new Blob(parts);
  if (cache) await cache.put(abs, new Response(blob)).catch(() => {});
  log(`model ${url}: ${(got / 1e6).toFixed(1)} MB downloaded`);
  return new Uint8Array(await blob.arrayBuffer());
}

let sessKey = null, sessP = null;
async function getSession(model, device) {
  const key = `${model.url || model.name}|${device}`;
  if (sessKey === key) return sessP;
  if (sessP) sessP.then(s => s.s.release()).catch(() => {});
  sessKey = key;
  sessP = (async () => loadSession(ort, model.bytes || await fetchModel(model.url), device, log))();
  sessP.catch(() => { if (sessKey === key) { sessKey = null; sessP = null; } });
  return sessP;
}

async function pickDevice(want) {
  if (want === 'wasm') return 'wasm';
  const gpu = self.navigator.gpu && await self.navigator.gpu.requestAdapter().catch(() => null);
  if (gpu) return 'webgpu';
  if (want === 'webgpu') throw new Error('WebGPU is not available in this browser');
  return 'wasm';
}

const count = m => { let c = 0; for (let i = 0; i < m.length; i++) c += m[i]; return c; };
function dice(a, b) { let i = 0, s = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; s += a[k] + b[k]; } return s ? 2 * i / s : 1; }

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const t0 = performance.now();
  try {
    stage('Reading input', 0);
    const inp = await openInput(data.files, log);
    let vol, info = {};
    if (inp.kind === 'nifti') { vol = await niftiVolume(inp.file, log); info.source = 'NIfTI'; }
    else {
      const pick = await pickSeries(inp.entries, log);
      info = { source: 'DICOM', series_description: pick.best.desc || '', body_part: pick.best.body_part || '', series_selection: pick.why, series_in_upload: pick.list };
      vol = await seriesVolume(pick.best.files, log);
      info.patient_age = vol.age || '';
    }
    const V = await loadVolume(vol, f => stage('Decoding slices', f));
    info.size = [V.nx, V.ny, V.nz]; info.spacing_mm = V.spacing.map(s => +s.toFixed(3));
    log(`volume ${V.nx}x${V.ny}x${V.nz} (L,P,S), spacing ${info.spacing_mm.join(' x ')} mm${V.oblique ? ', oblique/tilted acquisition (treated as axial)' : ''}`);
    if (V.nz > 1 && V.spacing[2] > 7) log('warning: slices thicker than 7 mm; volumes will be coarse');

    const vox = V.spacing[0] * V.spacing[1] * V.spacing[2] / 1000, masks = {}, stats = {};
    let device = null;
    if (data.methods.ai) {
      device = await pickDevice(data.device);
      stage('Loading model', 0);
      let sess;
      try { sess = await getSession(data.model, device); }
      catch (e) {
        if (device !== 'webgpu' || data.device === 'webgpu') throw e;
        log(`WebGPU session failed (${e.message}); using CPU`); device = 'wasm'; sess = await getSession(data.model, device);
      }
      const run = s => segment(ort, s, V, { batch: s.device === 'webgpu' ? 4 : 2, log, progress: f => stage(`AI segmentation (${s.device === 'webgpu' ? 'WebGPU' : 'CPU'})`, f) });
      try { masks.ai = await run(sess); }
      catch (e) {
        if (sess.device !== 'webgpu' || data.device === 'webgpu') throw e;
        log(`WebGPU run failed (${e.message}); retrying on CPU`); device = 'wasm';
        masks.ai = await run(await getSession(data.model, 'wasm'));
      }
      stats.ai_ml = count(masks.ai) * vox;
    }
    if (data.methods.csf) {
      stage('CSF threshold baseline', 0);
      const r = csfBaseline(V, { log, progress: f => stage('CSF threshold baseline', f) });
      masks.csf = r.mask; stats.csf_ml = count(r.mask) * vox; stats.brain_ml = r.brainMl;
    }
    if (masks.ai && masks.csf) stats.dice_ai_vs_csf = dice(masks.ai, masks.csf);
    const seconds = (performance.now() - t0) / 1000;
    log(`done in ${seconds.toFixed(1)}s`);
    post('result', { V, masks, stats, info, device, seconds }, [V.data.buffer, ...Object.values(masks).map(m => m.buffer)]);
  } catch (e) {
    console.error(e);
    post('error', { msg: e && e.message ? e.message : String(e) });
  }
};
