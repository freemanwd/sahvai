# tools

Training, export and test scripts for NeuroKids models. Run them from this folder.

| file | does |
|---|---|
| `neurokids_model.py` | `resnet34_sa` (the paper's fastai ResNet-34 U-Net with self-attention), `lite` (small U-Net for pipeline tests) and `BrowserWrapper`, the ONNX contract the page expects |
| `preprocess.py` | reference preprocessing (−100…100 HU window → uint8 → `cv2.equalizeHist`) and the paper's slice-consistency post-processing |
| `train.py` | trains on the paper's folder layout with generalised Dice loss and one-cycle Adam |
| `export_onnx.py` | checkpoint → ONNX (optional float16 weights), with metadata and a PyTorch parity check |
| `test-preprocess.mjs` | checks the browser preprocessing in `lib/hydro.js` against OpenCV, pixel for pixel |

## Requirements

```bash
pip install torch torchvision fastai pydicom opencv-python onnx onnxruntime onnxconverter-common
```

`resnet34_sa` downloads ImageNet ResNet-34 weights from torchvision on first use.

## Paper settings

`train.py` defaults follow `notebooks/Train.ipynb` in fast-radiology/hydrocephalus: 512 × 512 input, batch 10, `fit_one_cycle(5, 1e-4, pct_start=0.3, wd=1e-7)`, flips, ±5° rotation and up to 1.1× zoom.
The paper ran 10-fold cross-validation by patient (`split/split.csv` there). Pass held-out patients with `--val-patients`.

## How the pipeline-test weights were made

```bash
python train.py --data ../samples-as-paper-layout --arch lite --no-pretrained --dedupe \
  --val-files IMG0135.dcm --epochs 24 --steps-per-epoch 10 --bs 3 --lr 3e-3 --wd 1e-4 --out runs/lite.pth
python export_onnx.py runs/lite.pth --out ../models/neurokids-lite-test.onnx
```

The data were fast-radiology's `data/` folder (4 unique slices of one scan). The held-out slice reached Dice 0.98, but it sits 0.7 mm from a training slice. This says nothing about other patients.

## Float16

`--fp16` halves the download. The script refuses the export if the float16 graph doesn't match PyTorch (activations can overflow); export without it in that case.
