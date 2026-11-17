"""Reference preprocessing, identical to fast-radiology/hydrocephalus `open_dcm_image`
except that the window is applied to Hounsfield units (slope/intercept applied).
The paper's data had intercept 0, where the two are the same.
The browser port (lib/hydro.js) is tested against this file.
"""
import cv2
import numpy as np
import pydicom

WINDOW_MIN, WINDOW_MAX = -100, 100


def hu(ds):
    a = ds.pixel_array.astype(np.float64)
    return a * float(getattr(ds, 'RescaleSlope', 1) or 1) + float(getattr(ds, 'RescaleIntercept', 0) or 0)


def window_equalise(hu_slice):
    """HU slice -> uint8 after the paper's -100..100 window and cv2.equalizeHist."""
    a = np.clip(hu_slice, WINDOW_MIN, WINDOW_MAX)
    a = ((a - WINDOW_MIN) / (WINDOW_MAX - WINDOW_MIN) * 255).astype(np.uint8)
    return cv2.equalizeHist(a)


def model_input(hu_slice, size=512):
    """HU slice -> float32 [1, size, size] in [0, 1], the BrowserWrapper input."""
    a = window_equalise(hu_slice)
    if a.shape != (size, size):
        a = cv2.resize(a, (size, size), interpolation=cv2.INTER_LINEAR)
    return (a.astype(np.float32) / 255.0)[None]


def load_dcm(fn):
    return hu(pydicom.dcmread(fn))


def load_mask(fn):
    return (pydicom.dcmread(fn).pixel_array > 0).astype(np.uint8)


def postprocess(masks):
    """Slice-to-slice consistency from the paper (masks: [Z, H, W] uint8, slice order)."""
    m = masks.copy().astype(np.uint8)
    for i in range(1, len(m) - 1):
        m[i] |= m[i - 1] & m[i + 1]
        m[i] &= m[i - 1] | m[i + 1]
    return m
