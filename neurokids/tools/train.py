"""Train a NeuroKids ventricle segmentation model.

Data layout (same as fast-radiology/hydrocephalus):
    DATA/<patient>/<exam>/CT/*.dcm      axial head CT slices
    DATA/<patient>/<exam>/label/*.dcm   same file names, 0/1 ventricle masks

Paper settings (default for --arch resnet34_sa): ImageNet ResNet-34 U-Net with
self-attention, generalised Dice loss, one-cycle Adam, lr 1e-4, wd 1e-7, 5 epochs,
batch 10 on a GPU, flips / rotate +-5 deg / zoom <= 1.1 augmentation.

Example:
    python tools/train.py --data /path/to/DATA --val-patients P7,P12 --out runs/r34.pth
    python tools/export_onnx.py runs/r34.pth --arch resnet34_sa --fp16 --out models/my-model.onnx
"""
import argparse
import hashlib
import math
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

import neurokids_model as nm
from preprocess import load_dcm, load_mask, window_equalise


def find_pairs(root, dedupe):
    pairs, seen = [], set()
    for ct in sorted(Path(root).rglob('CT/*.dcm')):
        lab = ct.parent.parent / 'label' / ct.name
        if not lab.exists():
            continue
        if dedupe:
            h = hashlib.md5(ct.read_bytes()).hexdigest()
            if h in seen:
                continue
            seen.add(h)
        patient = ct.relative_to(root).parts[0]
        pairs.append((patient, ct, lab))
    return pairs


def load(pairs, size):
    xs, ys = [], []
    for _, ct, lab in pairs:
        x = window_equalise(load_dcm(ct)).astype(np.float32) / 255
        y = load_mask(lab).astype(np.float32)
        if x.shape != (size, size):
            x = F.interpolate(torch.from_numpy(x)[None, None], (size, size), mode='bilinear', align_corners=False)[0, 0].numpy()
            y = F.interpolate(torch.from_numpy(y)[None, None], (size, size), mode='nearest')[0, 0].numpy()
        xs.append(x)
        ys.append(y)
    return torch.tensor(np.stack(xs))[:, None], torch.tensor(np.stack(ys))[:, None]


def augment(x, y):
    """fastai get_transforms(max_rotate=5, max_lighting=0, max_warp=0): flip, rotate, zoom."""
    n = x.shape[0]
    th = []
    for _ in range(n):
        a = math.radians(random.uniform(-5, 5))
        s = 1 / random.uniform(1.0, 1.1)
        fx = -1 if random.random() < 0.5 else 1
        th.append([[s * math.cos(a) * fx, -s * math.sin(a), 0], [s * math.sin(a) * fx, s * math.cos(a), 0]])
    grid = F.affine_grid(torch.tensor(th, dtype=x.dtype), x.shape, align_corners=False)
    return (F.grid_sample(x, grid, mode='bilinear', padding_mode='border', align_corners=False),
            (F.grid_sample(y, grid, mode='nearest', padding_mode='zeros', align_corners=False) > 0.5).float())


def generalized_dice_loss(logits, target):
    """Port of hydrocephalus.losses.GeneralizedDiceLoss (flattened over the batch)."""
    p = torch.softmax(logits, 1).permute(0, 2, 3, 1).reshape(-1, 2)
    t = F.one_hot(target.long().reshape(-1), 2).float()
    ref, seg, inter = t.sum(0), p.sum(0), (t * p).sum(0)
    w = 1 / ref ** 2
    w[torch.isinf(w)] = 0
    score = 2 * (w * inter).sum() / (w * torch.maximum(seg + ref, torch.ones_like(w))).sum()
    return 1 - torch.nan_to_num(score, nan=1.0)


def dice(prob, y):
    pred = (prob > 0.5).float()
    return (2 * (pred * y).sum() / (pred.sum() + y.sum()).clamp(min=1)).item()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--arch', default='resnet34_sa', choices=['resnet34_sa', 'lite'])
    ap.add_argument('--no-pretrained', action='store_true')
    ap.add_argument('--val-patients', default='', help='comma-separated patient folder names held out')
    ap.add_argument('--val-files', default='', help='comma-separated CT file names held out (pipeline tests)')
    ap.add_argument('--epochs', type=int, default=5)
    ap.add_argument('--steps-per-epoch', type=int, default=0, help='0 = one pass over the training slices')
    ap.add_argument('--bs', type=int, default=10)
    ap.add_argument('--lr', type=float, default=1e-4)
    ap.add_argument('--wd', type=float, default=1e-7)
    ap.add_argument('--size', type=int, default=nm.INPUT_SIZE)
    ap.add_argument('--dedupe', action='store_true', help='drop byte-identical CT slices (the public sample data repeats slices)')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    pairs = find_pairs(a.data, a.dedupe)
    vp, vf = set(filter(None, a.val_patients.split(','))), set(filter(None, a.val_files.split(',')))
    is_val = lambda p: p[0] in vp or p[1].name in vf
    tr, va = [p for p in pairs if not is_val(p)], [p for p in pairs if is_val(p)]
    print(f'{len(tr)} training slices, {len(va)} validation slices, device {dev}')
    xt, yt = load(tr, a.size)
    xv, yv = load(va, a.size) if va else (None, None)

    net = nm.build(a.arch, pretrained=not a.no_pretrained).to(dev)
    model = nm.BrowserWrapper(net).to(dev)
    steps = a.steps_per_epoch or max(1, math.ceil(len(tr) / a.bs))
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=a.wd)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * steps, pct_start=0.3)

    for ep in range(a.epochs):
        net.train(); tot = 0
        for _ in range(steps):
            idx = torch.randint(len(tr), (min(a.bs, len(tr)),))
            x, y = augment(xt[idx], yt[idx])
            x, y = x.to(dev), y.to(dev)
            logits = net((x.repeat(1, 3, 1, 1) - model.mean) / model.std)
            loss = generalized_dice_loss(logits, y)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot += loss.item()
        msg = f'epoch {ep + 1}/{a.epochs}  train loss {tot / steps:.4f}'
        if va:
            net.eval()
            with torch.no_grad():
                pv = torch.cat([model(xv[i:i + 1].to(dev)).cpu() for i in range(len(xv))])
            msg += f'  val dice {dice(pv, yv):.4f}'
        print(msg, flush=True)

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    torch.save({'arch': a.arch, 'state_dict': net.state_dict(), 'args': vars(a)}, a.out)
    print('saved', a.out)


if __name__ == '__main__':
    main()
