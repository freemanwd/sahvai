import { filesFromDataTransfer } from './lib/source.js';
import { MODELS } from './lib/models.js';
import { niftiGz, sliceCsv, save } from './lib/export.js';
import { toMarkdown, toText, toPDF, toPNG } from './lib/report.js';
import { mountResearch, updateResearch } from './lib/research.js';

const $ = id => document.getElementById(id);
const t0 = performance.now();
let worker = null, busy = false, runStart = 0, cur = { frac: 0 }, R = null, custom = null, demoRun = false;

function log(msg) {
  const t = ((performance.now() - t0) / 1000).toFixed(2).padStart(7);
  $('log').textContent += `[${t}s] ${msg}\n`; $('log').scrollTop = $('log').scrollHeight;
  console.log('[neurokids]', msg);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const bits = [];
  const gpu = navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null);
  bits.push(gpu ? 'WebGPU available' : 'no WebGPU');
  bits.push(crossOriginIsolated ? `${Math.min(navigator.hardwareConcurrency || 4, 16)} CPU threads` : '1 CPU thread');
  $('caps').textContent = bits.join(' · ');
})();

// ---- model picker
function modelOptions() {
  const opts = MODELS.map(m => `<option value="${m.id}">${esc(m.name)}</option>`);
  if (custom) opts.unshift(`<option value="custom">${esc(custom.name)} (your file)</option>`);
  $('model').innerHTML = opts.join('');
  if (custom) $('model').value = 'custom';
  modelNote();
}
function currentModel() {
  if ($('model').value === 'custom' && custom) return { kind: 'custom', name: custom.name, bytes: custom.bytes, validated: true, note: '' };
  return MODELS.find(m => m.id === $('model').value) || MODELS[0];
}
function modelNote() {
  const m = currentModel(), el = $('modelNote');
  el.classList.toggle('good', m.kind === 'custom' || m.validated);
  el.innerHTML = m.kind === 'custom'
    ? `<h2>Using your model: ${esc(m.name)}</h2><p>Results are only as good as its training data. Check the masks slice by slice before using any number.</p>`
    : `<h2>${m.validated ? 'Model' : 'No validated AI weights loaded'}</h2><p>${esc(m.note)} ${m.validated ? '' : 'Until then, treat the AI mask as a demo and lean on the CSF baseline for rough volumes.'}</p>`;
}
$('model').onchange = () => { modelNote(); $('mAi').checked = currentModel().validated !== false; };
// The built-in weights are a pipeline test; keep the AI method off by default until real weights are chosen.
$('mAi').checked = currentModel().validated !== false;
$('modelFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  custom = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  log(`loaded model file ${f.name} (${(f.size / 1e6).toFixed(1)} MB)`);
  modelOptions();
  $('mAi').checked = true;
};
modelOptions();

// research tools are on the page from the start; report buttons wait for a scan
const REPORT_BTNS = ['exMd', 'exTxt', 'exPdf', 'exPng'];
function exportState() { for (const id of REPORT_BTNS) $(id).disabled = !R; $('exHint').textContent = R ? 'Reports use the slice shown in the viewer. They hold measurements and scan geometry only, no names or dates.' : 'Load a scan to enable the report buttons. Reports use the slice shown in the viewer and hold measurements and scan geometry only, no names or dates.'; }

// ---- worker
function startWorker() {
  if (worker) return;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
  worker.onerror = e => { log(`worker error: ${e.message}`); setStage(`Error: ${e.message}`, 0); done(); };
}
function device() { return document.querySelector('input[name=device]:checked').value; }

function run(files) {
  files = [...files];
  if (!files.length || busy) return;
  const methods = { ai: $('mAi').checked, csf: $('mCsf').checked };
  if (!methods.ai && !methods.csf) { setStage('Pick at least one method', 0); $('status').hidden = false; return; }
  busy = true; runStart = performance.now();
  $('drop').classList.add('busy'); $('status').hidden = false;
  log('---- new scan');
  log(`${files.length} file(s): ${files.slice(0, 3).map(f => f.webkitRelativePath || f.name).join(', ')}${files.length > 3 ? ', …' : ''}`);
  setStage('Starting', 0);
  startWorker();
  const m = currentModel();
  worker.postMessage({ type: 'run', files, device: device(), methods, model: m.bytes ? { name: m.name, bytes: m.bytes } : { url: m.url, name: m.name } });
}
function done() { busy = false; $('drop').classList.remove('busy'); }
function setStage(name, frac) { cur = { frac }; $('stage').textContent = name; $('bar').style.width = `${Math.round(frac * 100)}%`; showPct(); }
function showPct() {
  const pct = cur.frac > 0 ? `${Math.round(cur.frac * 100)}%` : '';
  $('pct').textContent = busy ? [pct, `${((performance.now() - runStart) / 1000).toFixed(0)}s`].filter(Boolean).join(' · ') : pct;
}
setInterval(() => { if (busy) showPct(); }, 1000);

function onMessage({ data }) {
  if (data.type === 'log') log(data.msg);
  else if (data.type === 'progress') setStage(data.stage, data.frac);
  else if (data.type === 'error') { log(`ERROR: ${data.msg}`); setStage(`Error: ${data.msg}`, 0); $('logbox').open = true; done(); }
  else if (data.type === 'result') { R = window.__nk = data; R.model = $('mAi').checked ? currentModel().name : null; R.aiDemo = $('mAi').checked && currentModel().validated === false; R.demo = demoRun; setStage(`Done in ${data.seconds.toFixed(1)}s`, 1); show(); done(); }
}

// ---- results
function show() {
  const { stats: s, info: i, V } = R;
  $('results').hidden = false;
  const cards = [];
  if (s.ai_ml !== undefined) cards.push(`<div class="card ai${R.aiDemo ? ' demo' : ''}"><div class="k">AI ventricular volume${R.aiDemo ? ' · DEMO' : ''}</div><div class="v">${s.ai_ml.toFixed(1)} <small>mL</small></div><div class="s">${R.aiDemo ? 'pipeline-test weights: not a measurement' : esc(R.model || '')}</div></div>`);
  if (s.csf_ml !== undefined) cards.push(`<div class="card csf"><div class="k">CSF baseline volume</div><div class="v">${s.csf_ml.toFixed(1)} <small>mL</small></div><div class="s">threshold −5…16 HU, central components</div></div>`);
  if (s.dice_ai_vs_csf !== undefined) cards.push(`<div class="card"><div class="k">AI vs baseline agreement</div><div class="v">${s.dice_ai_vs_csf.toFixed(2)} <small>Dice</small></div><div class="s">1 = identical masks</div></div>`);
  cards.push(`<div class="card"><div class="k">Series</div><div class="s" style="font-size:13.5px;color:var(--text)">${esc(i.series_description || i.source || '')}${i.patient_age ? ` · age ${esc(i.patient_age)}` : ''}<br>${V.nx}×${V.ny}×${V.nz} · ${V.spacing.map(x => x.toFixed(2)).join(' × ')} mm<br>${R.device ? (R.device === 'webgpu' ? 'WebGPU' : 'CPU') + ' · ' : ''}${R.seconds.toFixed(1)} s</div></div>`);
  $('cards').innerHTML = cards.join('');
  $('dlAi').disabled = !R.masks.ai; $('dlCsf').disabled = !R.masks.csf;
  $('oAi').parentElement.style.display = R.masks.ai ? '' : 'none';
  $('oCsf').parentElement.style.display = R.masks.csf ? '' : 'none';
  setupViewer();
  if ($('researchBox')) updateResearch($('researchBox'), R); else mountResearch($('researchHost'), () => R);
  exportState();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- viewer
const cv = $('cv'), ctx = cv.getContext('2d');
let img = null, areas = null;
function setupViewer() {
  const { V } = R;
  cv.width = V.nx; cv.height = V.ny;
  // keep physical aspect ratio
  const ar = (V.nx * V.spacing[0]) / (V.ny * V.spacing[1]);
  cv.style.aspectRatio = ar; cv.style.width = ar >= 1 ? '100%' : 'auto'; cv.style.height = ar >= 1 ? 'auto' : '100%';
  img = ctx.createImageData(V.nx, V.ny);
  const plane = V.nx * V.ny, a = new Float64Array(V.nz);
  const m = (R.aiDemo && R.masks.csf) || R.masks.ai || R.masks.csf;
  for (let z = 0; z < V.nz; z++) { let c = 0; for (let i = z * plane; i < (z + 1) * plane; i++) c += m[i]; a[z] = c; }
  areas = a;
  $('z').max = V.nz - 1;
  $('z').value = largest();
  draw();
}
function largest() { let b = 0; for (let z = 0; z < areas.length; z++) if (areas[z] > areas[b]) b = z; return b; }
function draw() {
  if (!R) return;
  const { V, masks } = R, z = +$('z').value, plane = V.nx * V.ny, o = z * plane;
  const [c, w] = $('win').value.split(',').map(Number), lo = c - w / 2, sc = 255 / w;
  const al = +$('alpha').value, sa = $('oAi').checked && masks.ai, sb = $('oCsf').checked && masks.csf;
  const d = img.data, vol = V.data;
  for (let i = 0; i < plane; i++) {
    let g = (vol[o + i] - lo) * sc; g = g < 0 ? 0 : g > 255 ? 255 : g;
    let r = g, gg = g, b = g;
    const A = sa && masks.ai[o + i], B = sb && masks.csf[o + i];
    if (A && B) { r = r * (1 - al) + 255 * al; gg = gg * (1 - al) + 255 * al; b = b * (1 - al) + 255 * al; }
    else if (A) { r = r * (1 - al) + 34 * al; gg = gg * (1 - al) + 211 * al; b = b * (1 - al) + 238 * al; }
    else if (B) { r = r * (1 - al) + 251 * al; gg = gg * (1 - al) + 146 * al; b = b * (1 - al) + 60 * al; }
    d[4 * i] = r; d[4 * i + 1] = gg; d[4 * i + 2] = b; d[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  $('zlab').textContent = `${z + 1} / ${V.nz}`;
  const px = V.spacing[0] * V.spacing[1] / 100, parts = [];
  for (const [k, lab] of [['ai', 'AI'], ['csf', 'Baseline']]) if (masks[k]) {
    let n = 0; for (let i = o; i < o + plane; i++) n += masks[k][i];
    parts.push(`${lab}: ${(n * px).toFixed(2)} cm²`);
  }
  $('sliceInfo').innerHTML = `z = ${(V.origin[2] + z * V.spacing[2]).toFixed(1)} mm<br>` + parts.join('<br>') + (masks.ai && masks.csf ? '<br><small>white = both masks</small>' : '');
}
['z', 'win', 'oAi', 'oCsf', 'alpha'].forEach(id => $(id).addEventListener('input', draw));
$('jump').onclick = () => { $('z').value = largest(); draw(); };
cv.addEventListener('wheel', e => { if (!R) return; e.preventDefault(); $('z').value = +$('z').value + (e.deltaY > 0 ? -1 : 1); draw(); }, { passive: false });
window.addEventListener('keydown', e => {
  if (!R || /INPUT|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); $('z').value = +$('z').value + (e.key === 'ArrowUp' ? 1 : -1); draw(); }
});

// ---- downloads
const stamp = () => new Date().toISOString().slice(0, 10);
$('dlCsv').onclick = () => R && save(sliceCsv(R.V, R.masks), `neurokids-slices-${stamp()}.csv`);
$('dlAi').onclick = async () => R?.masks.ai && save(await niftiGz(R.masks.ai, R.V, 'NeuroKids AI ventricle mask'), `neurokids-ai-mask-${stamp()}.nii.gz`);
$('dlCsf').onclick = async () => R?.masks.csf && save(await niftiGz(R.masks.csf, R.V, 'NeuroKids CSF baseline mask'), `neurokids-csf-mask-${stamp()}.nii.gz`);
$('dlCt').onclick = async () => R && save(await niftiGz(R.V.data, R.V, 'NeuroKids CT (HU)'), `neurokids-ct-${stamp()}.nii.gz`);
$('dlJson').onclick = () => {
  if (!R) return;
  const { V, stats, info } = R;
  const out = {
    disclaimer: 'Research use only. Not a medical device and not for diagnosis or treatment decisions.',
    tool: 'NeuroKids (https://freemanwd.github.io/NeuroKids/)', model: R.model,
    ai_ventricular_volume_ml: stats.ai_ml === undefined ? null : +stats.ai_ml.toFixed(2),
    csf_baseline_volume_ml: stats.csf_ml === undefined ? null : +stats.csf_ml.toFixed(2),
    dice_ai_vs_baseline: stats.dice_ai_vs_csf === undefined ? null : +stats.dice_ai_vs_csf.toFixed(4),
    grid: { size_lps: [V.nx, V.ny, V.nz], spacing_mm: V.spacing, origin_lps_mm: V.origin, oblique: V.oblique },
    ...info, device: R.device, seconds: +R.seconds.toFixed(1),
  };
  save(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }), `neurokids-summary-${stamp()}.json`);
};

// ---- inputs
$('files').onchange = e => { demoRun = false; run(e.target.files); e.target.value = ''; };
$('folder').onchange = e => { demoRun = false; run(e.target.files); e.target.value = ''; };
$('sample').onclick = async () => {
  if (busy) return;
  const names = await (await fetch('samples/index.json')).json();
  const files = await Promise.all(names.map(async n => new File([await (await fetch('samples/' + n)).blob()], n.replace(/\//g, '_'))));
  demoRun = true; run(files);
};
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('over'); demoRun = false; run(await filesFromDataTransfer(e.dataTransfer)); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// ---- report exports (Markdown, Text, PDF, PNG) and the research export box
const z = () => +$('z').value;
$('exMd').onclick = () => R && save(new Blob([toMarkdown(R, z())], { type: 'text/markdown' }), `NeuroKids_Report_${stamp()}.md`);
$('exTxt').onclick = () => R && save(new Blob([toText(R, z())], { type: 'text/plain' }), `NeuroKids_Report_${stamp()}.txt`);
$('exPdf').onclick = async () => { if (!R) return; try { await toPDF(R, z(), cv); } catch (e) { log(`PDF export failed: ${e.message}`); $('logbox').open = true; } };
$('exPng').onclick = async () => { if (!R) return; try { await toPNG(R, z(), cv); } catch (e) { log(`PNG export failed: ${e.message}`); $('logbox').open = true; } };
$('exRx').onclick = () => { const b = $('researchBox'); if (!b) return; b.open = !b.open; if (b.open) b.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };

mountResearch($('researchHost'), () => R);
exportState();
