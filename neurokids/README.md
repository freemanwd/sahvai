# NeuroKids

**https://freemanwd.github.io/NeuroKids/**

Part of [NeuroKids Research](https://freemanwd.github.io/sahvai/neurokids-research/). A mirror also runs at https://freemanwd.github.io/sahvai/neurokids/.

Ventricular system segmentation for **paediatric hydrocephalus** on head CT, running entirely in the browser.
Drop in a DICOM study (folder, zip or loose files) or a NIfTI volume. NeuroKids picks the axial head series, segments the ventricles slice by slice, reports the ventricular volume, and lets you scroll through the masks and download them.

It combines two open projects:

- **Segmentation pipeline:** [fast-radiology/hydrocephalus](https://github.com/fast-radiology/hydrocephalus) (MIT): Klimont M, Flieger M, Rzeszutek J, Stachera J, Zakrzewska A, Jończyk-Potoczna K. *Automated ventricular system segmentation in paediatric patients treated for hydrocephalus using deep learning methods.* BioMed Res Int 2019:3059170. [doi:10.1155/2019/3059170](https://doi.org/10.1155/2019/3059170)
- **Browser engine:** [RADAR in the browser](https://github.com/jarrelscy/radar-web) by jarrelscy (CC BY-NC-SA 4.0), the in-browser DICOM reader and ONNX Runtime Web set-up behind [jarrelscy/radar-onnx](https://huggingface.co/jarrelscy/radar-onnx).

We were inspired to build these education and research tools by [NeuroKids.org](https://neurokids.org/), a non-profit for children with hydrocephalus and spina bifida, and by Dr Giselle Coelho and Dr Benjamin Warf. This project is independent of NeuroKids.org.

> **Research use only.** Not a medical device. Not validated or approved for clinical use. Do not use for diagnosis, shunt revision or any other clinical decision.

Images never leave the computer. They are read and processed in the browser tab and nothing is uploaded.

## What RADAR contributes, and what it doesn't

RADAR (Alibaba DAMO Academy) is a generalist **abdominal** CT model. Its weights do not apply to head CT, so NeuroKids does not run them. What NeuroKids reuses is radar-web's browser machinery:

- the zip / folder / DICOM / NIfTI readers (`lib/source.js`, `lib/dicom.js`, `lib/nifti.js`), including JPEG lossless, JPEG-LS, JPEG 2000 and HTJ2K codecs
- series grouping and slice placement (`lib/series.js`, changed to prefer head soft-tissue series)
- the ONNX Runtime Web build with WebGPU and threaded WebAssembly, and the cross-origin-isolation service worker

## Methods on the page

| Method | What it does | Status |
|---|---|---|
| **AI U-Net** | The paper's preprocessing (−100…100 HU window → uint8 → histogram equalisation, bit-exact with OpenCV), a 2D U-Net per 512 × 512 axial slice, argmax, then the paper's slice-to-slice consistency filter | Needs trained weights, see below |
| **CSF threshold baseline** | No AI. Brain = largest soft-tissue region inside bone per slice; voxels at −5…16 HU more than 3 mm inside the brain edge; 3D components; central ones kept | Works now; a rough estimate that can include cisternal CSF and miss slit ventricles |

Both report volume in mL. When both run, their Dice agreement is shown.

## Model weights: important

The fast-radiology repository publishes code but **no trained weights**, and its sample data is 4 unique labelled slices from one scan.
The site ships `models/neurokids-lite-test.onnx`, a small U-Net trained on those 3 slices (the 4th held out) purely to test the pipeline end to end.
**It will not generalise to other patients.** Do not use its volumes.

To get a real model:

1. Assemble labelled scans in the paper's layout: `DATA/<patient>/<exam>/CT/*.dcm` with matching `DATA/<patient>/<exam>/label/*.dcm` (0/1 masks, same file names).
2. Train the paper's network (ImageNet ResNet-34 U-Net with self-attention, generalised Dice loss) on a GPU:
   ```bash
   pip install torch torchvision fastai pydicom opencv-python onnx onnxruntime onnxconverter-common
   cd tools
   python train.py --data /path/to/DATA --val-patients P7,P12 --out runs/r34.pth   # paper defaults
   python export_onnx.py runs/r34.pth --fp16 --name "NeuroKids R34 v1" --out ../models/r34-v1.onnx
   ```
3. Either use **Load .onnx** on the page (the file stays local), or add an entry to `lib/models.js` and push. Files over 100 MB can't go in a GitHub repo; host them on Hugging Face and reference a pinned-commit URL, as radar-web does.

Other published CT ventricle models worth requesting from their authors:

- **Ventricle** (Da Mutten R, Staartjes VE, et al., Zürich): see [Related programs](#related-programs). Its weights could run in the browser if the authors grant permission; the multi-class, two-stage output would need a small adapter.

Any ONNX model with this contract works:

- input `image`: float32 `[N, 1, 512, 512]`, the preprocessed slice divided by 255
- output `prob`: float32 `[N, 1, 512, 512]`, probability of ventricular CSF

ImageNet normalisation and the 3-channel repeat happen inside the graph (`tools/neurokids_model.py`, `BrowserWrapper`).

## Related programs

Other free tools that hydrocephalus researchers may want to consider alongside NeuroKids:

### Ventricle (University Hospital Zürich)

**https://github.com/raffaele7/Ventricle**

A fully automated pipeline for **ventricular subregion volumetry on head CT**. It labels the frontal, temporal and posterior horns, the body of each lateral ventricle, the atria, and the third and fourth ventricles. It uses YOLOv5 object detection followed by a 2D U-Net, packaged as a stand-alone **Windows application** (PyQt `.exe`): choose a folder of DICOM scans and click *Analyze Ventricles*. No coding is needed. The download link is in the repository's readme.

Things to know before using it:
- It was developed and validated in **adults** shunted for hydrocephalus (mean age about 69), so check its performance on paediatric scans before relying on it.
- It runs locally on Windows. NeuroKids runs in any modern browser.
- The repository states no licence; contact the authors about research or redistribution terms.

Please cite:
- Da Mutten R, Zanier O, Carretta A, Palandri G, Bottini M, de Wilde D, Schneider UC, Regli L, Serra C, Staartjes VE. *Fully automated volumetry of ventricular subregions on computed tomography using object detection and semantic segmentation.* NeuroImage: Reports 2026;6(1):100325. [doi:10.1016/j.ynirp.2026.100325](https://doi.org/10.1016/j.ynirp.2026.100325)
- *Ventricular volume and width quantification using deep convolutional networks incorporated in a graphical user interface.* Brain and Spine 2024;4:103478. [doi:10.1016/j.bas.2024.103478](https://doi.org/10.1016/j.bas.2024.103478)

NeuroKids does not include Ventricle's code or weights.

## Outputs

**Export bar** (as in the SAHVAI calculator):
- **Export Markdown / Export Text:** a report with scan geometry, volumes, Dice agreement, the largest cross-section, methods and reference
- **Export PDF:** the same report on one A4 page, with the slice shown in the viewer and its overlays (jsPDF, bundled locally)
- **Export PNG:** a 1600 × 900 summary card with the slice and the key numbers, ready for slides
- **Research export** (adapted from the SAHVAI Lab research export): adds the scan to the site's de-identified pediatric hydrocephalus dataset, kept in the browser (IndexedDB), or downloads it as a zip (`record.csv`, `data_dictionary.csv`, `provenance.json`, `fhir_bundle.json`, NIfTI masks). The whole site dataset exports as CSV, JSON Lines, an HL7 FHIR R4 bundle, a data dictionary or a REDCap data dictionary.
  - Fields: site, pseudonymised subject, scan number and timing, days from the index procedure, scan geometry, AI and baseline volumes, Dice, optional reader measurements (reference volume, Evans' index, FOHR), optional clinical variables (age in months, sex, gestational age, head circumference, etiology, index treatment such as ETV/CPC or shunt), and outcome columns to fill in later.
  - Privacy: the study ID is turned into a pseudonym on the computer (HMAC-SHA-256 with a site key that can be backed up and shared across the site's computers). Dates become days from the procedure. Images and names are never exported.

**Data files:** ventricular volume (mL) per method; per-slice areas (CSV); masks and the CT as `.nii.gz` in one shared grid (LPS-ordered voxels, RAS affine), so they overlay in 3D Slicer, ITK-SNAP or nibabel; a JSON summary (series, spacing, volumes, device, timings).

## Running locally

Any static file server works:

```bash
python3 -m http.server 8000   # open http://localhost:8000/
```

`coi-serviceworker.js` enables cross-origin isolation so WebAssembly can use multiple threads.

Check the browser preprocessing against OpenCV:

```bash
python3 -c "import sys; sys.path.insert(0,'tools'); import glob; from preprocess import *; [window_equalise(load_dcm(f)).tofile('/tmp/eq_'+f.split('/')[-1]+'.u8') for f in glob.glob('samples/ct/*.dcm')]"
node tools/test-preprocess.mjs /tmp      # expects 0 differing pixels
```

## Limitations

- 2D slice-wise model; very thick slices (> 7 mm) give coarse volumes.
- Gantry-tilted series are treated as axial (flagged in the log and JSON).
- Enhanced multi-frame DICOM isn't supported yet (inherited from radar-web).
- The CSF baseline is a heuristic. It has not been tuned on paediatric hydrocephalus scans.
- Tested in desktop Chrome. Large thin-slice studies need several GB of RAM.

## Licence

NeuroKids adapts radar-web code, so it is released under **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)** (see `LICENSE`): non-commercial use, with attribution, and derivatives under the same licence.
The fast-radiology pipeline and sample slices are MIT (© 2019 fast-radiology). Bundled third-party libraries are listed in `THIRD_PARTY_LICENSES.md`.
