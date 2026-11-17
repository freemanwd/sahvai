"""Export a trained checkpoint to the ONNX contract the NeuroKids page loads.

    python tools/export_onnx.py runs/r34.pth --out models/my-model.onnx [--fp16]

Then either drop the .onnx onto the page's "Load model" button, or host it
(e.g. on Hugging Face) and add it to MODELS in lib/models.js.
Checks the ONNX output against PyTorch on a random input before finishing.
"""
import argparse
import json

import numpy as np
import torch

import neurokids_model as nm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('--out', required=True)
    ap.add_argument('--fp16', action='store_true', help='store weights as float16 (halves the download; inputs/outputs stay float32)')
    ap.add_argument('--name', default='', help='human-readable model name stored in the ONNX metadata')
    a = ap.parse_args()

    ck = torch.load(a.ckpt, map_location='cpu', weights_only=False)
    net = nm.build(ck['arch'], pretrained=False)
    net.load_state_dict(ck['state_dict'])
    model = nm.BrowserWrapper(net).eval()
    x = torch.rand(1, 1, nm.INPUT_SIZE, nm.INPUT_SIZE)
    torch.onnx.export(model, (x,), a.out, input_names=['image'], output_names=['prob'],
                      dynamic_axes={'image': {0: 'n'}, 'prob': {0: 'n'}}, opset_version=17, dynamo=False)

    import onnx
    m = onnx.load(a.out)
    if a.fp16:
        from onnxconverter_common import float16
        m = float16.convert_float_to_float16(m, keep_io_types=True)
    meta = {'neurokids_contract': '1', 'arch': ck['arch'], 'name': a.name or ck['arch'],
            'input': 'image float32 [N,1,512,512]: HU window -100..100 -> uint8 -> equalizeHist -> /255',
            'output': 'prob float32 [N,1,512,512]: P(ventricular CSF)', 'train_args': json.dumps(ck.get('args', {}))}
    for k, v in meta.items():
        p = m.metadata_props.add(); p.key, p.value = k, v
    onnx.save(m, a.out)

    import onnxruntime as ort
    s = ort.InferenceSession(a.out, providers=['CPUExecutionProvider'])
    got = s.run(None, {'image': x.numpy()})[0]
    with torch.no_grad():
        ref = model(x).numpy()
    err = np.abs(got - ref).max()
    print(f'saved {a.out}; max |onnx - torch| = {err:.2e}')
    if not np.isfinite(err) or err > (1e-2 if a.fp16 else 1e-4):
        raise SystemExit('WARNING: ONNX output does not match PyTorch' + (' (float16 overflow?); export again without --fp16' if a.fp16 else ''))


if __name__ == '__main__':
    main()
