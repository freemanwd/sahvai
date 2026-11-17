// Built-in models. Add trained weights here (any ONNX file exported with
// tools/export_onnx.py: image [N,1,512,512] -> prob [N,1,512,512]).
// Large files are best hosted on Hugging Face and referenced by a pinned-commit URL.
export const MODELS = [
  {
    id: 'lite-test',
    name: 'Pipeline-test U-Net (4 sample slices only)',
    url: 'models/neurokids-lite-test.onnx',
    validated: false,
    note: 'Trained on the 4 public sample slices from fast-radiology/hydrocephalus, all from one scan. ' +
          'It exists to exercise the pipeline end to end. It will not generalise to other scans; load your own trained model for measurements.',
  },
];
