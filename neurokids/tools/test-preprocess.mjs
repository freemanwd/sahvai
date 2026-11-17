// node tools/test-preprocess.mjs <dir of reference .u8 files written by OpenCV>
// Checks lib/hydro.js windowEqualise against cv2.equalizeHist bit for bit on the sample slices.
import { readFile } from 'node:fs/promises';
import { windowEqualise } from '../lib/hydro.js';
import { sliceHeader, decodeSlice } from '../lib/dicom.js';
const ref = process.argv[2] || '/tmp';
let bad = 0;
for (const n of ['IMG0132', 'IMG0133', 'IMG0134', 'IMG0135']) {
  const buf = await readFile(new URL(`../samples/ct/${n}.dcm`, import.meta.url));
  const entry = { name: n, size: buf.length, head: async k => buf.subarray(0, k), blob: async () => new Blob([buf]) };
  const hu = await decodeSlice(entry, await sliceHeader(entry));
  const got = windowEqualise(hu), want = new Uint8Array(await readFile(`${ref}/eq_${n}.dcm.u8`));
  let diff = 0; for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) diff++;
  console.log(`${n}: ${diff} of ${got.length} pixels differ`); bad += diff;
}
process.exit(bad ? 1 : 0);
