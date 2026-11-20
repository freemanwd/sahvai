// Research export for NeuroKids, adapted from the SAHVAI Lab research export
// (SAHVAI-Lab/SAHVAI-Calculator, sahvai-web/lib/research.js).
//
// Each site keeps its own de-identified pediatric hydrocephalus dataset: one row per scan, stored in this browser
// (IndexedDB) and exported as CSV + data dictionary (REDCap, R / Python, NIH ScHARe), a REDCap data dictionary,
// JSON Lines, an HL7 FHIR R4 bundle, and a per-scan zip with NIfTI masks.
//
// Privacy by design: images and names never leave the computer. The study ID is turned into a pseudonym on this
// computer (HMAC-SHA-256 with a key that stays at the site). Dates become days from the index procedure, age is
// stored in whole months (capped at 90 years), and free text is not collected. The site decides what is exported,
// under its own approvals.

import { niftiGz } from './export.js';

export const SCHEMA_VERSION = 'neurokids-research-1.0';
export const APP_VERSION = '2026-11-20';
const SITE_URL = 'https://freemanwd.github.io/NeuroKids/';
const CODE_SYSTEM = SITE_URL + 'fhir/CodeSystem/neurokids-research';

const F = (name, group, type, label, o = {}) => ({ name, group, type, label, ...o });
const SEX = [['1', 'Male'], ['2', 'Female'], ['3', 'Unknown or not reported']];
// etiology: HCRN registry categories, split so the ETV Success Score (Kulkarni 2009) can be computed
export const ETIOLOGY = [['1', 'Post-hemorrhagic (IVH of prematurity)'], ['2', 'Post-infectious'], ['3', 'Myelomeningocele (spina bifida)'], ['4', 'Aqueductal stenosis'],
  ['5', 'Tectal tumor'], ['6', 'Other (non-tectal) brain tumor'], ['7', 'Other congenital (e.g. Dandy-Walker, cyst, encephalocele)'], ['8', 'Other'], ['9', 'Unknown']];
// index treatment; shunt types follow the NINDS Assessment of Shunt Function CRF (F2158, Chiari CDE)
export const TREATMENT = [['0', 'None yet'], ['1', 'Ventriculoperitoneal shunt'], ['2', 'Ventriculoatrial shunt'], ['3', 'Ventriculopleural shunt'], ['4', 'ETV'], ['5', 'ETV/CPC'],
  ['6', 'Ventricular reservoir or subgaleal shunt (temporising)'], ['7', 'External ventricular drain'], ['8', 'Other']];
const FONTANELLE = [['1', 'Soft / flat'], ['2', 'Full'], ['3', 'Bulging / tense'], ['4', 'Closed'], ['9', 'Not assessed']];
const FAMHX = [['0', 'No'], ['1', 'Yes, treated'], ['2', 'Yes, untreated'], ['9', 'Unknown']];
const DEPEND = [['1', 'Yes (shunt)'], ['2', 'No'], ['3', 'ETV / ETV-CPC, no shunt']];
const YN = [['1', 'Yes'], ['0', 'No']];
// ETV Success Score: age + etiology + previous shunt (Kulkarni AV et al., J Pediatr 2009;155:254-9)
export function etvss(ageMonths, etiology, previousShunt) {
  if (ageMonths === '' || ageMonths == null || !isFinite(+ageMonths) || !etiology || etiology === '9' || previousShunt === '' || previousShunt == null) return null;
  const m = +ageMonths, a = m < 1 ? 0 : m < 6 ? 10 : m < 12 ? 30 : m < 120 ? 40 : 50;
  const e = { 2: 0, 1: 20, 3: 20, 6: 20, 4: 30, 5: 30, 7: 30, 8: 30 }[etiology];
  return a + e + (String(previousShunt) === '1' ? 0 : 10);
}
const CDE_CM = 'NINDS Chiari Malformation I CDE', CDE_CP = 'NINDS Cerebral Palsy CDE', CDE_REHAB = 'NINDS NeuroRehab CDE (Infant/Pediatric Demographics)', CDE_GEN = 'NINDS General CDE';
const SCAN_TIMING = [['1', 'Before treatment'], ['2', 'After treatment (follow-up)'], ['3', 'Suspected treatment failure'], ['9', 'Not known']];

export const FIELDS = [
  F('record_id', 'admin', 'text', 'Record ID', { note: 'random UUID made when the record is created' }),
  F('schema_version', 'admin', 'text', 'Schema version'),
  F('site_id', 'admin', 'text', 'Site code', { note: 'short code chosen by the site, e.g. MCF' }),
  F('site_country', 'admin', 'text', 'Site country', { note: 'ISO 3166-1 alpha-2 code, e.g. US, BR' }),
  F('subject_id', 'admin', 'text', 'Subject pseudonym', { note: 'study ID turned into a pseudonym on the site computer (HMAC-SHA-256, site key), or a study code as entered; never an MRN or name' }),
  F('subject_id_method', 'admin', 'category', 'Subject ID method', { choices: [['hmac', 'Pseudonymised on site (HMAC-SHA-256, site key)'], ['entered', 'Study code as entered by the site']] }),
  F('scan_number', 'admin', 'integer', 'Scan number for this subject', { note: '1 = first CT', min: 1 }),
  F('scan_timing', 'admin', 'category', 'Scan timing', { choices: SCAN_TIMING }),
  F('days_from_procedure', 'admin', 'integer', 'Days from index procedure to scan', { unit: 'd', note: 'negative = before the procedure; calendar dates are not exported' }),
  F('record_created_month', 'admin', 'text', 'Month the record was created', { note: 'YYYY-MM' }),
  F('input_format', 'imaging', 'category', 'Input format', { choices: [['dicom', 'DICOM'], ['nifti', 'NIfTI'], ['demo', 'Public sample slices']] }),
  F('slice_thickness_mm', 'imaging', 'number', 'Slice spacing', { unit: 'mm' }),
  F('grid_size', 'imaging', 'text', 'Volume size (x, y, z voxels)'),
  F('grid_spacing_mm', 'imaging', 'text', 'Voxel spacing (x, y, z)', { unit: 'mm' }),
  F('oblique', 'imaging', 'yesno', 'Tilted / oblique acquisition'),
  F('tool', 'analysis', 'text', 'Tool', { note: 'NeuroKids hydrocephalus measurement tool' }),
  F('ai_model', 'analysis', 'text', 'AI model'),
  F('ai_model_validated', 'analysis', 'yesno', 'AI model has validated weights', { note: '0 = pipeline-test weights; AI volume is not a measurement' }),
  F('app_version', 'analysis', 'text', 'App version'),
  F('compute', 'analysis', 'category', 'Compute', { choices: [['webgpu', 'WebGPU'], ['wasm', 'CPU (WebAssembly)']] }),
  F('runtime_s', 'analysis', 'number', 'Run time', { unit: 's' }),
  F('vol_ventricles_ai_ml', 'volumes', 'number', 'Ventricular volume, AI U-Net', { unit: 'mL' }),
  F('vol_ventricles_csf_ml', 'volumes', 'number', 'Ventricular volume, CSF threshold baseline', { unit: 'mL' }),
  F('vol_brain_approx_ml', 'volumes', 'number', 'Brain volume seen by the baseline (approximate)', { unit: 'mL' }),
  F('dice_ai_vs_csf', 'volumes', 'number', 'Dice, AI vs baseline', { min: 0, max: 1 }),
  F('ref_ventricles_ml', 'reference', 'number', 'Reference (expert) ventricular volume', { unit: 'mL', note: 'optional; from manual segmentation' }),
  F('ventriculomegaly_imaging', 'reference', 'yesno', 'Ventriculomegaly on imaging (reader)', { cde: 'Imaging hydrocephalus ventriculomegaly finding indicator', cde_id: 'C21757', source: CDE_CM }),
  F('evans_index', 'reference', 'number', "Evans' index (reader)", { min: 0, max: 1, cde: 'Evans index ratio value', cde_id: 'C60636', source: CDE_CM }),
  F('fohr', 'reference', 'number', 'Frontal and occipital horn ratio (reader)', { min: 0, max: 1, note: 'FOHR; widely used in pediatric hydrocephalus; no NINDS CDE' }),
  F('age_months', 'clinical', 'integer', 'Age at scan', { unit: 'months', note: 'whole months (corrected age for preterm infants if the site uses it); capped at 1080 (90 years)', min: 0, max: 1080, cde: 'Age', source: CDE_GEN }),
  F('sex', 'clinical', 'category', 'Sex', { choices: SEX, cde: 'Sex / gender', source: CDE_GEN }),
  F('gestational_age_weeks', 'clinical', 'integer', 'Gestational age at birth', { unit: 'weeks', min: 22, max: 44, cde: 'Gestational age', source: `${CDE_CP} (Supplemental - Highly Recommended); ${CDE_REHAB}` }),
  F('birth_weight_g', 'clinical', 'integer', 'Birth weight', { unit: 'g', min: 300, max: 6500, cde: 'Birth weight report value', cde_id: 'C00311', source: `${CDE_REHAB}; ${CDE_CP}` }),
  F('head_circumference_cm', 'clinical', 'number', 'Head circumference at scan', { unit: 'cm', note: 'infant hydrocephalus metric (HCRN, ETV/CPC follow-up); no NINDS CDE' }),
  F('fontanelle', 'clinical', 'category', 'Anterior fontanelle at scan', { choices: FONTANELLE, note: 'infant hydrocephalus metric; no NINDS CDE' }),
  F('etiology', 'clinical', 'category', 'Etiology of hydrocephalus', { choices: ETIOLOGY, note: 'Hydrocephalus Clinical Research Network categories, split for the ETV Success Score' }),
  F('previous_shunt', 'clinical', 'yesno', 'Previous CSF shunt', { note: 'ETV Success Score component' }),
  F('family_history_hydrocephalus', 'clinical', 'category', 'Family history of hydrocephalus', { choices: FAMHX, cde: 'Hydrocephalus family history treated / untreated indicator', cde_id: 'C22448; C22447', source: CDE_CM }),
  F('treatment', 'clinical', 'category', 'Index treatment', { choices: TREATMENT, note: 'shunt types as in the NINDS Assessment of Shunt Function CRF (F2158)', source: CDE_CM }),
  F('etv_success_score', 'clinical', 'integer', 'ETV Success Score', { unit: '%', min: 0, max: 90, note: 'computed: age + etiology + previous shunt (Kulkarni et al., J Pediatr 2009;155:254-9); predicted 6-month ETV success' }),
  F('treatment_success_6m', 'outcome', 'yesno', 'Treatment success at 6 months', { note: 'no further CSF diversion surgery or death from hydrocephalus within 6 months of the index procedure (HCRN / ETVSS definition); filled in later' }),
  F('csf_diversion_dependent', 'outcome', 'category', 'Shunt-dependent hydrocephalus at follow-up', { choices: DEPEND, cde: 'Shunt-dependent hydrocephalus', source: 'NINDS SAH CDE, Shunt Dependency CRF (F2482; Exploratory)', note: 'filled in later' }),
  F('reintervention', 'outcome', 'yesno', 'Any re-intervention for hydrocephalus', { note: 'filled in later' }),
];
export const FIELD = Object.fromEntries(FIELDS.map(f => [f.name, f]));
export const CLINICAL = ['age_months', 'sex', 'gestational_age_weeks', 'birth_weight_g', 'head_circumference_cm', 'fontanelle', 'etiology', 'previous_shunt', 'family_history_hydrocephalus', 'treatment'];
const OUTCOMES = ['treatment_success_6m', 'csf_diversion_dependent', 'reintervention'];
const READER = ['ref_ventricles_ml', 'ventriculomegaly_imaging', 'evans_index', 'fohr'];

// ---------- settings (site code, country, site key) ----------
const SKEY = 'neurokids-research-settings';
export function settings() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch { /* ignore */ }
  if (!s.siteKey) { const b = crypto.getRandomValues(new Uint8Array(32)); s.siteKey = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); saveSettings(s); }
  return s;
}
export function saveSettings(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* ignore */ } }
const hexBytes = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
// pseudonym = site code + 12 base-32 characters of HMAC-SHA-256(site key, normalised study ID)
export async function pseudonym(studyId, s = settings()) {
  const id = String(studyId || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!id) return '';
  const key = await crypto.subtle.importKey('raw', hexBytes(s.siteKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
  const A = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; let out = '', bits = 0, v = 0;
  for (const b of mac) { v = (v << 8) | b; bits += 8; while (bits >= 5 && out.length < 12) { out += A[(v >> (bits - 5)) & 31]; bits -= 5; } }
  return `${(s.siteId || 'SITE').toUpperCase()}-${out}`;
}

// ---------- the site dataset (IndexedDB) ----------
const DB = 'neurokids-research', STORE = 'records';
function db() {
  return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'record_id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(STORE, mode), out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); });
}
export const allRecords = async () => (await tx('readonly', st => st.getAll())) || [];
export const putRecord = rec => tx('readwrite', st => st.put(rec));
export const clearRecords = () => tx('readwrite', st => st.clear());
export async function countRecords() { try { return (await tx('readonly', st => st.count())) || 0; } catch { return 0; } }

// ---------- building a record ----------
const r3 = x => x == null || !isFinite(x) ? null : +(+x).toFixed(3);
const num = x => x === '' || x == null || !isFinite(+x) ? null : +x;
export function dicomAgeMonths(a) {   // "006M", "003Y", "010W", "020D" -> whole months, capped at 1080
  const m = /^(\d{1,3})\s*([YMWD])?$/i.exec(String(a || '').trim()); if (!m) return null;
  const n = +m[1], u = (m[2] || 'Y').toUpperCase();
  const mo = u === 'Y' ? n * 12 : u === 'M' ? n : u === 'W' ? n * 7 / 30.4375 : n / 30.4375;
  return Math.min(1080, Math.floor(mo));
}
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const x = Date.parse(a), y = Date.parse(b); if (!isFinite(x) || !isFinite(y)) return null;
  return Math.round((y - x) / 864e5);
}
// R: the NeuroKids result (V, stats, info, device, seconds, model, aiDemo)
export async function buildRecord(R, form) {
  const s = settings(), i = R.info || {}, st = R.stats || {}, V = R.V;
  const subject = form.studyIsCode ? String(form.studyId || '').trim() : await pseudonym(form.studyId, s);
  const rec = {
    record_id: crypto.randomUUID(), schema_version: SCHEMA_VERSION, site_id: (s.siteId || '').toUpperCase() || null, site_country: (s.country || '').toUpperCase() || null,
    subject_id: subject || null, subject_id_method: subject ? (form.studyIsCode ? 'entered' : 'hmac') : null,
    scan_number: num(form.scanNumber), scan_timing: form.scanTiming || null, days_from_procedure: daysBetween(form.procedureDate, form.scanDate),
    record_created_month: new Date().toISOString().slice(0, 7),
    input_format: R.demo ? 'demo' : i.source === 'DICOM' ? 'dicom' : i.source === 'NIfTI' ? 'nifti' : null,
    slice_thickness_mm: r3(V.spacing[2]), grid_size: [V.nx, V.ny, V.nz].join(' x '), grid_spacing_mm: V.spacing.map(v => +(+v).toFixed(3)).join(' x '), oblique: V.oblique ? 1 : 0,
    tool: 'NeuroKids hydrocephalus measurement tool', ai_model: R.model || null, ai_model_validated: R.model ? (R.aiDemo ? 0 : 1) : null, app_version: APP_VERSION,
    compute: R.device || null, runtime_s: r3(R.seconds),
    vol_ventricles_ai_ml: r3(st.ai_ml), vol_ventricles_csf_ml: r3(st.csf_ml), vol_brain_approx_ml: r3(st.brain_ml), dice_ai_vs_csf: r3(st.dice_ai_vs_csf),
  };
  for (const k of [...CLINICAL, ...READER]) {
    const v = form[k], n = num(v), f = FIELD[k];
    rec[k] = v === '' || v == null ? null : f.type === 'category' ? String(v) : n == null ? null : f.type === 'integer' || f.type === 'yesno' ? Math.min(f.max ?? Infinity, Math.round(n)) : r3(n);
  }
  rec.etv_success_score = etvss(rec.age_months, rec.etiology, rec.previous_shunt);
  for (const k of OUTCOMES) rec[k] = null;
  for (const f of FIELDS) if (!(f.name in rec)) rec[f.name] = null;
  return rec;
}

// ---------- writers ----------
const csvCell = v => v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
export const toCSV = rows => [FIELDS.map(f => f.name).join(','), ...rows.map(r => FIELDS.map(f => csvCell(r[f.name])).join(','))].join('\r\n') + '\r\n';
export const toJSONL = rows => rows.map(r => JSON.stringify(Object.fromEntries(FIELDS.map(f => [f.name, r[f.name] ?? null])))).join('\n') + '\n';
export function dictionaryCSV() {
  const cols = ['variable', 'group', 'type', 'label', 'unit', 'choices', 'min', 'max', 'cde_concept', 'cde_id', 'cde_source', 'note'];
  return [cols.join(','), ...FIELDS.map(f => [f.name, f.group, f.type, f.label, f.unit, (f.choices || (f.type === 'yesno' ? [['1', 'Yes'], ['0', 'No']] : [])).map(([c, l]) => `${c}=${l}`).join(' | '),
    f.min, f.max, f.cde, f.cde_id, f.source, f.note].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
export function redcapDictionaryCSV() {
  const H = ['Variable / Field Name', 'Form Name', 'Section Header', 'Field Type', 'Field Label', 'Choices, Calculations, OR Slider Labels', 'Field Note', 'Text Validation Type OR Show Slider Number',
    'Text Validation Min', 'Text Validation Max', 'Identifier?', 'Branching Logic (Show field only if...)', 'Required Field?', 'Custom Alignment', 'Question Number (surveys only)', 'Matrix Group Name', 'Matrix Ranking?', 'Field Annotation'];
  const FORM = { admin: 'scan_record', imaging: 'scan_record', analysis: 'scan_record', volumes: 'ventricular_measures', reference: 'ventricular_measures', clinical: 'clinical', outcome: 'outcomes' };
  const HEAD = { admin: 'Record and site', imaging: 'Imaging', analysis: 'Analysis', volumes: 'Ventricular volumes', reference: 'Reader measurements', clinical: 'Clinical (optional)', outcome: 'Outcomes' };
  let last = '';
  const rows = FIELDS.map(f => {
    const ch = f.choices ? f.choices.map(([c, l]) => `${c}, ${l}`).join(' | ') : '';
    const typ = f.type === 'category' ? 'dropdown' : f.type === 'yesno' ? 'yesno' : 'text';
    const val = f.type === 'integer' ? 'integer' : f.type === 'number' ? 'number' : '';
    const sec = f.group !== last ? HEAD[f.group] : ''; last = f.group;
    return [f.name, FORM[f.group], sec, typ, f.label, ch, [f.unit, f.note, f.cde ? `CDE: ${f.cde}${f.cde_id ? ` (${f.cde_id})` : ''}, ${f.source}` : ''].filter(Boolean).join('; '), val, f.min ?? '', f.max ?? '', '', '', f.name === 'record_id' ? 'y' : '', '', '', '', '', ''].map(csvCell).join(',');
  });
  return [H.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}
export function toFHIR(rows) {
  const entries = [], seen = new Set(), pid = s => 'p-' + String(s || 'unknown').replace(/[^A-Za-z0-9.-]/g, '-');
  for (const r of rows) {
    const p = pid(r.subject_id);
    if (!seen.has(p)) { seen.add(p); entries.push({ fullUrl: `urn:uuid:${p}`, resource: { resourceType: 'Patient', id: p, identifier: [{ system: `${SITE_URL}fhir/site/${r.site_id || 'SITE'}`, value: r.subject_id || 'unknown' }], gender: { 1: 'male', 2: 'female', 3: 'unknown' }[r.sex] } }); }
    for (const f of FIELDS) {
      if (!['volumes', 'reference', 'clinical', 'outcome'].includes(f.group)) continue;
      const v = r[f.name]; if (v == null || v === '') continue;
      const value = f.type === 'category' ? { valueCodeableConcept: { coding: [{ system: `${CODE_SYSTEM}/${f.name}`, code: String(v), display: (f.choices.find(c => c[0] === String(v)) || [])[1] }] } }
        : f.type === 'yesno' ? { valueBoolean: !!+v } : f.unit ? { valueQuantity: { value: +v, unit: f.unit, system: 'http://unitsofmeasure.org', code: f.unit === 'months' ? 'mo' : f.unit === 'weeks' ? 'wk' : f.unit } } : { valueQuantity: { value: +v } };
      entries.push({ fullUrl: `urn:uuid:${r.record_id}-${f.name}`, resource: { resourceType: 'Observation', id: `${r.record_id}-${f.name}`.slice(0, 64), status: 'final',
        category: [{ text: f.group === 'clinical' || f.group === 'outcome' ? 'clinical' : 'imaging' }], code: { coding: [{ system: CODE_SYSTEM, code: f.name, display: f.label }, ...(f.cde_id ? f.cde_id.split('; ').map(id => ({ system: 'https://www.commondataelements.ninds.nih.gov', code: id, display: f.cde })) : [])], text: f.label },
        subject: { reference: `urn:uuid:${p}` }, ...value, note: [{ text: `record ${r.record_id}; scan ${r.scan_number ?? '?'}; site ${r.site_id || '?'}` }] } });
    }
  }
  return { resourceType: 'Bundle', type: 'collection', meta: { tag: [{ system: CODE_SYSTEM, code: SCHEMA_VERSION }] }, entry: entries };
}
export function provenance(rec, R) {
  return {
    schema_version: SCHEMA_VERSION, app: 'NeuroKids hydrocephalus measurement tool', app_url: SITE_URL, app_version: APP_VERSION,
    ai_model: rec.ai_model, ai_model_validated: rec.ai_model_validated, compute: rec.compute, runtime_s: rec.runtime_s, browser: navigator.userAgent, exported: new Date().toISOString().slice(0, 7),
    methods: {
      ai: 'fast-radiology/hydrocephalus pipeline (Klimont et al., BioMed Res Int 2019): -100..100 HU window, histogram equalisation, 2D U-Net per 512 x 512 axial slice, P > 0.5, slice-to-slice consistency filter',
      csf_baseline: 'brain = largest soft-tissue region inside bone per slice; CSF -5..16 HU more than 3 mm inside the brain edge; central 3D components kept',
    },
    grid: { size: [R.V.nx, R.V.ny, R.V.nz], spacing_mm: R.V.spacing, oblique: R.V.oblique },
    privacy: 'Images and names never leave the site computer. The subject ID is a pseudonym (HMAC-SHA-256 with a key kept at the site) or a study code entered by the site; calendar dates are reduced to days from the index procedure; age is stored in whole months. The masks have no patient metadata. Export and sharing follow the site\'s own approvals (IRB/ethics, data use agreements).',
    disclaimer: 'Research and education use only. Not a medical device; not for diagnosis or treatment decisions.',
  };
}
export const README = `NeuroKids research export (${SCHEMA_VERSION})
NeuroKids hydrocephalus measurement tool - ${SITE_URL}

record.csv            one row: this scan's de-identified measurements (variables in data_dictionary.csv)
data_dictionary.csv   every variable: label, type, unit, codes
provenance.json       methods, model, versions, compute and privacy notes
fhir_bundle.json      the same measurements as HL7 FHIR R4 Observations (local code system)
mask_ai.nii.gz        AI ventricle mask (when run), no patient metadata
mask_csf.nii.gz       CSF baseline mask (when run), no patient metadata

Import record.csv, or the whole site dataset, into REDCap, NIH ScHARe, R or Python.
Research and education use only; not a medical device.
`;

// ---------- zip (stored, no compression; the masks are already gzipped) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  const put = (dv, list) => list.forEach(([o, v, n]) => n === 4 ? dv.setUint32(o, v, true) : dv.setUint16(o, v, true));
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
    const name = enc.encode(f.name), c = crc32(data), h = new DataView(new ArrayBuffer(30)), cd = new DataView(new ArrayBuffer(46));
    put(h, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dt, 2], [12, dd, 2], [14, c, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]);
    put(cd, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dt, 2], [14, dd, 2], [16, c, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]);
    parts.push(new Uint8Array(h.buffer), name, data); central.push(new Uint8Array(cd.buffer), name);
    off += 30 + name.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  put(e, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, off, 4], [20, 0, 2]]);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
function saveBlob(blob, name) { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

// ---------- the Research export box ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const opt = (choices, v) => `<option value="">—</option>` + choices.map(([c, l]) => `<option value="${c}"${String(v ?? '') === c ? ' selected' : ''}>${esc(l)}</option>`).join('');

// mountResearch(host, getR): getR() returns the current NeuroKids result
export function mountResearch(host, getR) {
  const s = settings(), R0 = getR() || {}, age = dicomAgeMonths(R0.info?.patient_age);
  const el = document.createElement('details'); el.className = 'rx'; el.id = 'researchBox';
  const st = R0.stats || {};
  const meas = [st.ai_ml != null ? `AI ${st.ai_ml.toFixed(1)} mL${R0.aiDemo ? ' (demo weights)' : ''}` : '', st.csf_ml != null ? `CSF baseline ${st.csf_ml.toFixed(1)} mL` : ''].filter(Boolean).join(' · ');
  el.innerHTML = `<summary>&#128300; Research export <span class="sub">add this scan to your site's de-identified hydrocephalus dataset, or download it</span></summary>
  <div class="in">
    <div class="meas">This scan: ${esc(meas || 'no volumes')}</div>
    <div class="row">
      <label>Site code<input class="site w6" maxlength="12" placeholder="e.g. MCF" value="${esc(s.siteId || '')}"></label>
      <label>Country<input class="country w4" maxlength="2" placeholder="US" value="${esc(s.country || '')}"></label>
      <label title="Hashed into a pseudonym on this computer; the ID itself is never stored or exported (unless you tick the box for an already-coded study ID)">Study / subject ID (hashed here, never stored)<input class="study w12" placeholder="e.g. HC-0012" autocomplete="off"></label>
      <span class="pseudo" title="What is stored and exported instead of the study ID">—</span>
      <label class="chk"><input type="checkbox" class="iscode"> already a coded study ID (keep as typed)</label>
    </div>
    <div class="row">
      <label>Scan no.<input class="scanno w4" type="number" min="1" value="1"></label>
      <label>Scan timing<select class="timing">${opt(SCAN_TIMING, '')}</select></label>
      <label>Index procedure date<input class="proc w9" type="date"></label>
      <label>Scan date<input class="scand w9" type="date"></label>
      <span class="days fine">days from procedure: —</span>
    </div>
    <details class="more"><summary>Clinical variables (optional; NINDS CDE where one exists)</summary>
      <div class="row">
        <label title="NINDS General CDE: Age (here in whole months)">Age (months)<input class="c-age_months w6" type="number" min="0" max="1080" value="${esc(age ?? '')}"></label>
        <label title="NINDS General CDE: Sex / gender">Sex<select class="c-sex">${opt(SEX, '')}</select></label>
        <label title="NINDS CP CDE (Supplemental - Highly Recommended) and NeuroRehab Infant/Pediatric CDE: gestational age">Gestational age (wk)<input class="c-gestational_age_weeks w4" type="number" min="22" max="44"></label>
        <label title="NINDS CDE C00311: Birth weight report value">Birth weight (g)<input class="c-birth_weight_g w6" type="number" min="300" max="6500" step="10"></label>
        <label title="Infant hydrocephalus metric (no NINDS CDE)">Head circ. (cm)<input class="c-head_circumference_cm w4" type="number" step="0.1" min="20" max="70"></label>
        <label title="Infant hydrocephalus metric (no NINDS CDE)">Fontanelle<select class="c-fontanelle">${opt(FONTANELLE, '')}</select></label>
      </div>
      <div class="row">
        <label title="Hydrocephalus Clinical Research Network categories">Etiology<select class="c-etiology w12">${opt(ETIOLOGY, '')}</select></label>
        <label title="ETV Success Score component">Previous shunt<select class="c-previous_shunt">${opt(YN, '')}</select></label>
        <label title="NINDS Chiari CDE C22448 / C22447: hydrocephalus family history treated / untreated indicator">Family history<select class="c-family_history_hydrocephalus">${opt(FAMHX, '')}</select></label>
        <label title="Shunt types as in the NINDS Assessment of Shunt Function CRF (F2158)">Index treatment<select class="c-treatment w12">${opt(TREATMENT, '')}</select></label>
        <span class="pseudo etvss" title="ETV Success Score (Kulkarni et al., J Pediatr 2009): age + etiology + previous shunt; predicted 6-month ETV success">ETVSS —</span>
      </div>
      <p class="fine">CDE sources: NINDS General, Cerebral Palsy and NeuroRehab (infant/pediatric) CDEs; NINDS Chiari I CDEs for hydrocephalus family history, ventriculomegaly, Evans' index and shunt types. NINDS has no dedicated pediatric hydrocephalus CDE set, so etiology follows the Hydrocephalus Clinical Research Network, and the ETV Success Score is computed from age, etiology and previous shunt. Hover a field to see its source.</p>
    </details>
    <details class="more"><summary>Reader measurements (optional)</summary>
      <div class="row">
        <label>Reference volume (mL)<input class="c-ref_ventricles_ml w6" type="number" step="0.1" min="0"></label>
        <label title="NINDS CDE C21757: Imaging hydrocephalus ventriculomegaly finding indicator">Ventriculomegaly<select class="c-ventriculomegaly_imaging">${opt(YN, '')}</select></label>
        <label title="NINDS CDE C60636: Evans index ratio value">Evans' index<input class="c-evans_index w4" type="number" step="0.01" min="0" max="1"></label>
        <label title="Frontal and occipital horn ratio">FOHR<input class="c-fohr w4" type="number" step="0.01" min="0" max="1"></label>
      </div>
      <p class="fine">Outcomes (treatment success at 6 months, shunt dependence, re-intervention) are left blank, to be added later in your own database.</p>
    </details>
    <div class="acts">
      <button class="rbtn add" type="button">Add to site dataset</button>
      <button class="rbtn ghost dl" type="button">Download this scan (.zip)</button>
      <span class="msg"></span>
    </div>
    <div class="acts ds">
      <span class="fine count"></span>
      <button class="rbtn ghost small dsCsv" type="button">Dataset CSV</button>
      <button class="rbtn ghost small dsJsonl" type="button">JSON Lines</button>
      <button class="rbtn ghost small dsDict" type="button">Data dictionary</button>
      <button class="rbtn ghost small dsRedcap" type="button">REDCap dictionary</button>
      <button class="rbtn ghost small dsFhir" type="button">FHIR bundle</button>
      <button class="rbtn ghost small dsKey" type="button" title="Download the site key so other computers at your site make the same pseudonyms">Back up site key</button>
      <label class="rbtn ghost small" title="Load a site key backed up on another computer">Load site key<input class="keyFile" type="file" accept=".json" hidden></label>
      <button class="rbtn ghost small danger dsClear" type="button">Clear dataset</button>
    </div>
    <p class="fine">Nothing leaves this computer unless you download it. The study ID becomes a pseudonym, made with a key kept in this browser; back the key up and use the same one on every computer at your site. Dates become days from the procedure. Images and names are never exported. Use under your site's approvals. Adapted from the SAHVAI Lab research export.</p>
  </div>`;
  host.replaceChildren(el);
  const q = c => el.querySelector(c), msg = (t, err) => { q('.msg').textContent = t; q('.msg').classList.toggle('err', !!err); };
  const form = () => ({ studyId: q('.study').value, studyIsCode: q('.iscode').checked, scanNumber: q('.scanno').value, scanTiming: q('.timing').value,
    procedureDate: q('.proc').value, scanDate: q('.scand').value, ...Object.fromEntries([...CLINICAL, ...READER].map(k => [k, q('.c-' + k).value])) });
  const keep = () => { const x = settings(); x.siteId = q('.site').value.trim().toUpperCase(); x.country = q('.country').value.trim().toUpperCase(); saveSettings(x); };
  const refresh = async () => {
    keep(); const f = form();
    q('.pseudo').textContent = !f.studyId.trim() ? '—' : f.studyIsCode ? f.studyId.trim() : await pseudonym(f.studyId);
    const d = daysBetween(f.procedureDate, f.scanDate); q('.days').textContent = `days from procedure: ${d == null ? '—' : d}`;
    const e = etvss(f.age_months, f.etiology, f.previous_shunt); q('.etvss').textContent = `ETVSS ${e == null ? '—' : e + '%'}`;
  };
  const count = async () => { const n = await countRecords(); q('.count').innerHTML = `Site dataset in this browser: <b>${n}</b> scan${n === 1 ? '' : 's'}`; };
  el.addEventListener('input', refresh); el.addEventListener('change', refresh); refresh(); count();
  const record = async () => {
    const R = getR(); if (!R) { msg('Run a scan first.', true); return null; }
    const f = form(); if (!f.studyId.trim()) { msg('Enter a study ID (it is turned into a pseudonym).', true); q('.study').focus(); return null; }
    if (!settings().siteId) { msg('Enter your site code.', true); q('.site').focus(); return null; }
    return { rec: await buildRecord(R, f), R };
  };
  q('.add').onclick = async () => {
    const r = await record(); if (!r) return;
    try { await putRecord(r.rec); msg(`Added: ${r.rec.subject_id}, scan ${r.rec.scan_number ?? '?'}.`); count(); } catch (e) { msg(`Could not save in this browser (${e.message}). Use “Download this scan”.`, true); }
  };
  q('.dl').onclick = async () => {
    const r = await record(); if (!r) return;
    const files = [{ name: 'record.csv', data: toCSV([r.rec]) }, { name: 'data_dictionary.csv', data: dictionaryCSV() }, { name: 'provenance.json', data: JSON.stringify(provenance(r.rec, r.R), null, 2) },
      { name: 'fhir_bundle.json', data: JSON.stringify(toFHIR([r.rec]), null, 2) }, { name: 'README.txt', data: README }];
    if (r.R.masks.ai) files.push({ name: 'mask_ai.nii.gz', data: await niftiGz(r.R.masks.ai, r.R.V, 'NeuroKids AI ventricle mask') });
    if (r.R.masks.csf) files.push({ name: 'mask_csf.nii.gz', data: await niftiGz(r.R.masks.csf, r.R.V, 'NeuroKids CSF baseline mask') });
    const nm = `${r.rec.subject_id}_scan${r.rec.scan_number ?? 'x'}_neurokids.zip`.replace(/[^A-Za-z0-9._-]/g, '_');
    saveBlob(await zip(files), nm); msg(`Downloaded ${nm}.`);
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  const dsDl = async (fn, name, type) => { const rows = await allRecords(); if (!rows.length && name !== 'dict') { msg('The site dataset is empty.', true); return; } saveBlob(new Blob([fn(rows)], { type }), name); };
  q('.dsCsv').onclick = () => dsDl(toCSV, `neurokids-dataset-${stamp()}.csv`, 'text/csv');
  q('.dsJsonl').onclick = () => dsDl(toJSONL, `neurokids-dataset-${stamp()}.jsonl`, 'application/x-ndjson');
  q('.dsFhir').onclick = () => dsDl(rows => JSON.stringify(toFHIR(rows), null, 1), `neurokids-dataset-fhir-${stamp()}.json`, 'application/fhir+json');
  q('.dsDict').onclick = () => saveBlob(new Blob([dictionaryCSV()], { type: 'text/csv' }), 'neurokids-data-dictionary.csv');
  q('.dsRedcap').onclick = () => saveBlob(new Blob([redcapDictionaryCSV()], { type: 'text/csv' }), 'neurokids-redcap-dictionary.csv');
  q('.dsKey').onclick = () => { const x = settings(); saveBlob(new Blob([JSON.stringify({ neurokids_site_key: x.siteKey, site_id: x.siteId || '', country: x.country || '', note: 'Keep this file private: it turns study IDs into pseudonyms.' }, null, 1)], { type: 'application/json' }), `neurokids-site-key-${(x.siteId || 'SITE').toLowerCase()}.json`); };
  q('.keyFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const k = JSON.parse(await f.text()); if (!/^[0-9a-f]{64}$/.test(k.neurokids_site_key || '')) throw new Error('not a NeuroKids site key');
      const x = settings(); x.siteKey = k.neurokids_site_key; if (k.site_id) x.siteId = k.site_id; if (k.country) x.country = k.country; saveSettings(x);
      q('.site').value = x.siteId || ''; q('.country').value = x.country || ''; refresh(); msg('Site key loaded.'); } catch (err) { msg(`Could not load the key (${err.message}).`, true); }
  };
  let armed = false;
  q('.dsClear').onclick = async () => {
    if (!armed) { armed = true; q('.dsClear').textContent = 'Press again to delete all records'; setTimeout(() => { armed = false; q('.dsClear').textContent = 'Clear dataset'; }, 4000); return; }
    armed = false; q('.dsClear').textContent = 'Clear dataset'; await clearRecords(); count(); msg('Site dataset cleared.');
  };
  return el;
}
