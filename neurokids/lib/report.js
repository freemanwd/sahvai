// Report exports for NeuroKids: Markdown, plain text, PDF and PNG, in the style of the SAHVAI calculator's export bar.
// The reports hold measurements and scan geometry only: no names, IDs or dates from the images.

const TOOL_URL = 'https://freemanwd.github.io/NeuroKids/';
const DISCLAIMER = 'Research and education use only. Not a medical device; not for diagnosis, shunt or other treatment decisions.';
const REF = 'Klimont M, Flieger M, Rzeszutek J, et al. Automated ventricular system segmentation in paediatric patients treated for hydrocephalus using deep learning methods. BioMed Res Int 2019;2019:3059170. doi:10.1155/2019/3059170';
const f1 = x => x == null || !isFinite(x) ? '—' : (+x).toFixed(1);

// one plain summary shared by every format
export function summary(R, z) {
  const { V, stats: s, info: i, masks } = R, plane = V.nx * V.ny, px = V.spacing[0] * V.spacing[1] / 100;
  const area = (m, k) => { if (!m) return null; let c = 0; for (let j = k * plane; j < (k + 1) * plane; j++) c += m[j]; return c * px; };
  const ref = (R.aiDemo && masks.csf) || masks.ai || masks.csf;
  let peak = 0, best = ref ? -1 : null; if (ref) for (let k = 0; k < V.nz; k++) { const a = area(ref, k); if (a > best) { best = a; peak = k; } }
  return {
    created: new Date().toLocaleString(),
    series: i.series_description || i.source || '—', age: i.patient_age || '—', size: `${V.nx} × ${V.ny} × ${V.nz}`,
    spacing: V.spacing.map(x => x.toFixed(2)).join(' × ') + ' mm', oblique: V.oblique, compute: R.device ? (R.device === 'webgpu' ? 'WebGPU' : 'CPU (WebAssembly)') : '—', seconds: R.seconds,
    ai: s.ai_ml, csf: s.csf_ml, dice: s.dice_ai_vs_csf, brain: s.brain_ml, model: R.model, aiDemo: R.aiDemo,
    peakSlice: peak + 1, peakArea: best, slice: z + 1, nz: V.nz, sliceAi: area(masks.ai, z), sliceCsf: area(masks.csf, z),
  };
}

const rows = S => [
  ['Series', S.series], ['Patient age (DICOM)', S.age], ['Volume', `${S.size} voxels`], ['Voxel spacing', S.spacing + (S.oblique ? ' (tilted acquisition, treated as axial)' : '')],
  ['Compute', `${S.compute}${S.seconds ? `, ${S.seconds.toFixed(1)} s` : ''}`],
];
const results = S => [
  ...(S.ai != null ? [[`Ventricular volume, AI U-Net${S.aiDemo ? ' [DEMO]' : ''}`, `${f1(S.ai)} mL${S.aiDemo ? ' (pipeline-test weights: not a measurement)' : ''}`]] : []),
  ...(S.csf != null ? [['Ventricular volume, CSF threshold baseline', `${f1(S.csf)} mL`]] : []),
  ...(S.dice != null ? [['Agreement, AI vs baseline (Dice)', S.dice.toFixed(2)]] : []),
  ...(S.peakArea != null ? [['Largest ventricular cross-section', `slice ${S.peakSlice} of ${S.nz}, ${S.peakArea.toFixed(2)} cm²`]] : []),
];

export function toMarkdown(R, z) {
  const S = summary(R, z);
  const t = (h, r) => `| ${h[0]} | ${h[1]} |\n|---|---|\n` + r.map(([a, b]) => `| ${a} | ${b} |`).join('\n');
  return `# NeuroKids hydrocephalus measurement report

*${DISCLAIMER}*

**Exported:** ${S.created}
**Tool:** NeuroKids hydrocephalus measurement tool (${TOOL_URL})${S.model ? `\n**AI model:** ${S.model}` : ''}

## Scan
${t(['Item', 'Value'], rows(S))}

## Results
${t(['Measure', 'Value'], results(S))}

## Methods
- **AI U-Net:** fast-radiology/hydrocephalus pipeline. Each axial slice is windowed to −100…100 HU, histogram-equalised and segmented at 512 × 512; a voxel counts as ventricle where P > 0.5; then a slice-to-slice consistency filter is applied.
- **CSF threshold baseline (no AI):** brain is the largest soft-tissue region inside bone on each slice; voxels at −5…16 HU more than 3 mm inside the brain edge, grouped in 3D, central components kept.
- Volume = voxel count × voxel volume.

## Reference
${REF}
`;
}

export function toText(R, z) {
  const S = summary(R, z), w = 46, line = '='.repeat(64);
  const pad = r => r.map(([a, b]) => `  ${(a + ':').padEnd(w)} ${b}`).join('\n');
  return `${line}
NEUROKIDS HYDROCEPHALUS MEASUREMENT REPORT
${line}
${DISCLAIMER}

Exported: ${S.created}
Tool:     ${TOOL_URL}${S.model ? `\nAI model: ${S.model}` : ''}

SCAN
${pad(rows(S))}

RESULTS
${pad(results(S))}

METHODS
  AI U-Net: -100..100 HU window, histogram equalisation, 2D U-Net per 512 x 512 axial
  slice, P > 0.5, slice-to-slice consistency filter (fast-radiology/hydrocephalus).
  CSF baseline (no AI): -5..16 HU inside the brain, > 3 mm from its edge, central
  3D components. Volume = voxel count x voxel volume.

REFERENCE
  ${REF}
${line}
`;
}

// the viewer's current slice, at physical aspect, for the PDF and PNG
function sliceImage(cv, V, maxW, maxH) {
  const ar = (V.nx * V.spacing[0]) / (V.ny * V.spacing[1]);
  let w = maxW, h = w / ar; if (h > maxH) { h = maxH; w = h * ar; }
  const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cv, 0, 0, c.width, c.height);
  return c;
}

let jspdfP = null;
function loadJsPDF() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  return jspdfP ||= new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: new URL('../vendor/jspdf/jspdf.umd.min.js', import.meta.url).href });
    s.onload = () => res(window.jspdf); s.onerror = () => { jspdfP = null; rej(new Error('could not load the PDF library')); };
    document.head.appendChild(s);
  });
}

export async function toPDF(R, z, cv) {
  const { jsPDF } = await loadJsPDF(), S = summary(R, z);
  const doc = new jsPDF('p', 'mm', 'a4'), W = doc.internal.pageSize.getWidth(), M = 14;
  // the built-in PDF fonts are WinAnsi only: spell out the few symbols they lack
  const clean = s => Array.isArray(s) ? s.map(clean) : String(s).replace(/\u2212/g, '-').replace(/\u2026/g, '...').replace(/\u00b2/g, '2').replace(/[\u2018\u2019]/g, "'");
  const _t = doc.text.bind(doc), _s = doc.splitTextToSize.bind(doc);
  doc.text = (s, ...a) => _t(clean(s), ...a); doc.splitTextToSize = (s, ...a) => _s(clean(s), ...a);
  let y = 16;
  doc.setFillColor(11, 31, 29); doc.rect(0, 0, W, 26, 'F');
  doc.setTextColor(94, 234, 212); doc.setFontSize(17); doc.text('NeuroKids', M, 13);
  doc.setTextColor(231, 238, 240); doc.setFontSize(10); doc.text('Hydrocephalus measurement report · head CT', M, 20);
  doc.setFontSize(8); doc.text(TOOL_URL, W - M, 20, { align: 'right' });
  y = 34;
  doc.setTextColor(160, 30, 30); doc.setFontSize(8.5);
  doc.text(doc.splitTextToSize(DISCLAIMER, W - 2 * M), M, y); y += 7;
  doc.setTextColor(90, 100, 110); doc.text(`Exported ${S.created}`, M, y); y += 8;

  const section = t => { doc.setFontSize(11.5); doc.setTextColor(0, 81, 120); doc.text(t, M, y); y += 2; doc.setDrawColor(200, 215, 220); doc.line(M, y, W - M, y); y += 5; };
  const table = r => { doc.setFontSize(9.5); for (const [a, b] of r) { doc.setTextColor(70, 80, 90); doc.text(a, M + 2, y); doc.setTextColor(20, 25, 30); const lines = doc.splitTextToSize(String(b), W - M - 100); doc.text(lines, 100, y); y += 5 * lines.length; } y += 3; };

  section('Results');
  // big figures
  const big = [...(S.ai != null ? [[S.aiDemo ? 'AI (DEMO weights)' : 'AI U-Net', `${f1(S.ai)} mL`, S.aiDemo ? [150, 150, 150] : [8, 145, 178]]] : []),
    ...(S.csf != null ? [['CSF baseline', `${f1(S.csf)} mL`, [234, 88, 12]]] : []), ...(S.dice != null ? [['Dice AI vs baseline', S.dice.toFixed(2), [60, 70, 80]]] : [])];
  const bw = (W - 2 * M - (big.length - 1) * 4) / Math.max(1, big.length);
  big.forEach(([k, v, c], j) => {
    const x = M + j * (bw + 4); doc.setFillColor(243, 247, 248); doc.roundedRect(x, y, bw, 20, 2, 2, 'F');
    doc.setFillColor(...c); doc.rect(x, y, bw, 1.2, 'F');
    doc.setFontSize(8); doc.setTextColor(90, 100, 110); doc.text(k, x + 4, y + 7);
    doc.setFontSize(16); doc.setTextColor(...c); doc.text(v, x + 4, y + 16);
  });
  y += 26;
  table(results(S).slice(-1));

  // slice figure
  const img = sliceImage(cv, R.V, 900, 900), iw = 92, ih = iw * img.height / img.width;
  doc.addImage(img.toDataURL('image/jpeg', 0.92), 'JPEG', M, y, iw, ih);
  doc.setFontSize(8.5); doc.setTextColor(70, 80, 90);
  const cap = [`Slice ${S.slice} of ${S.nz} as shown in the viewer.`, 'Radiological view: patient right on the left.',
    ...(S.sliceAi != null ? [`AI area on this slice: ${S.sliceAi.toFixed(2)} cm² (cyan)`] : []), ...(S.sliceCsf != null ? [`Baseline area: ${S.sliceCsf.toFixed(2)} cm² (orange)`] : []),
    ...(S.sliceAi != null && S.sliceCsf != null ? ['White = both masks.'] : [])];
  doc.text(cap, M + iw + 6, y + 5);
  y += ih + 8;

  section('Scan'); table(rows(S));
  if (S.model) { section('AI model'); table([['Model', S.model]]); }
  section('Methods');
  doc.setFontSize(8.5); doc.setTextColor(50, 60, 70);
  const meth = doc.splitTextToSize('AI U-Net: each axial slice is windowed to −100…100 HU, histogram-equalised and segmented at 512 × 512 by a 2D U-Net (fast-radiology/hydrocephalus); P > 0.5, then a slice-to-slice consistency filter. CSF baseline (no AI): voxels at −5…16 HU more than 3 mm inside the brain edge, grouped in 3D, central components kept. Volume = voxel count × voxel volume.', W - 2 * M);
  if (y + meth.length * 4 > 280) { doc.addPage(); y = 18; }
  doc.text(meth, M, y); y += meth.length * 4 + 4;
  doc.setFontSize(7.5); doc.setTextColor(110, 120, 130);
  doc.text(doc.splitTextToSize('Reference: ' + REF, W - 2 * M), M, Math.min(y, 284));
  doc.save(`NeuroKids_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
}

export async function toPNG(R, z, cv) {
  const S = summary(R, z), W = 1600, H = 900, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), F = (s, w = 400) => `${w} ${s}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillStyle = '#0c1114'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b1f1d'; g.fillRect(0, 0, W, 92);
  g.fillStyle = '#5eead4'; g.font = F(40, 700); g.fillText('NeuroKids', 40, 58);
  g.fillStyle = '#93a3ab'; g.font = F(20); g.fillText('Hydrocephalus measurement report · head CT', 262, 57);
  g.textAlign = 'right'; g.fillText(TOOL_URL, W - 40, 57); g.textAlign = 'left';
  // slice
  const img = sliceImage(cv, R.V, 740, 740), ix = 40 + (740 - img.width) / 2, iy = 120 + (740 - img.height) / 2;
  g.fillStyle = '#000'; g.fillRect(40, 120, 740, 740); g.drawImage(img, ix, iy);
  g.fillStyle = '#8fb'; g.font = F(16, 600); g.fillText('R', 52, 495); g.fillText('L', 760, 495);
  g.fillStyle = '#cfd8dc'; g.font = F(16); g.fillText(`Slice ${S.slice} / ${S.nz}`, 52, 848);
  // numbers
  let x = 830, y = 150;
  const card = (k, v, sub, col) => {
    g.fillStyle = '#141b20'; g.fillRect(x, y, 730, 118); g.fillStyle = col; g.fillRect(x, y, 730, 5);
    g.fillStyle = '#93a3ab'; g.font = F(17, 600); g.fillText(k.toUpperCase(), x + 24, y + 38);
    g.fillStyle = '#e7eef0'; g.font = F(46, 700); g.fillText(v, x + 24, y + 92);
    if (sub) { g.fillStyle = '#93a3ab'; g.font = F(17); g.textAlign = 'right'; g.fillText(sub, x + 706, y + 92); g.textAlign = 'left'; }
    y += 136;
  };
  if (S.ai != null) card(`AI ventricular volume${S.aiDemo ? ' · DEMO' : ''}`, `${f1(S.ai)} mL`, S.aiDemo ? 'pipeline-test weights' : '', S.aiDemo ? '#6b7a82' : '#22d3ee');
  if (S.csf != null) card('CSF baseline volume', `${f1(S.csf)} mL`, 'threshold −5…16 HU', '#fb923c');
  if (S.dice != null) card('AI vs baseline agreement', `${S.dice.toFixed(2)} Dice`, '', '#94a3b8');
  g.fillStyle = '#cfd8dc'; g.font = F(18);
  const info = [`Series: ${S.series}`.slice(0, 70), `Age (DICOM): ${S.age}   ·   ${S.size} voxels`, `Spacing: ${S.spacing}`, S.peakArea != null ? `Largest cross-section: slice ${S.peakSlice}, ${S.peakArea.toFixed(2)} cm²` : '', `Exported ${new Date().toLocaleString()}`];
  info.forEach((t, j) => g.fillText(t, x, y + 10 + j * 30));
  g.fillStyle = '#f5c451'; g.font = F(16, 600);
  g.fillText('Research and education use only. Not a medical device; not for diagnosis or treatment decisions.', 40, 888);
  const a = Object.assign(document.createElement('a'), { download: `NeuroKids_Report_${new Date().toISOString().slice(0, 10)}.png`, href: c.toDataURL('image/png') });
  document.body.appendChild(a); a.click(); a.remove();
}
