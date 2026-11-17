"""NeuroKids model definitions.

`resnet34_sa` reproduces the network in fast-radiology/hydrocephalus
(fastai `unet_learner(models.resnet34, self_attention=True)`, 2 classes:
void / water, i.e. background / ventricular CSF).

`lite` is a small plain U-Net used only for the pipeline-test weights that
ship with the site, because no trained weights for the paper's model are
public. Both export to the same browser contract (see `BrowserWrapper`).
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
INPUT_SIZE = 512  # the paper trains at the native 512 x 512 matrix


def resnet34_sa(pretrained=True):
    """fastai DynamicUnet on a ResNet-34 body with self-attention, as in the paper."""
    from fastai.vision.learner import create_body
    from fastai.vision.models.unet import DynamicUnet
    from torchvision.models import resnet34, ResNet34_Weights

    weights = ResNet34_Weights.IMAGENET1K_V1 if pretrained else None
    body = create_body(resnet34(weights=weights), n_in=3, pretrained=pretrained)
    return DynamicUnet(body, n_out=2, img_size=(INPUT_SIZE, INPUT_SIZE), self_attention=True)


class _Block(nn.Sequential):
    def __init__(self, cin, cout):
        super().__init__(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )


class LiteUNet(nn.Module):
    """Plain 5-level U-Net, ~1.9 M parameters. Takes the same 3-channel ImageNet-normalised input."""

    def __init__(self, base=16, n_out=2):
        super().__init__()
        ch = [base, base * 2, base * 4, base * 8, base * 16]
        self.down = nn.ModuleList()
        cin = 3
        for c in ch:
            self.down.append(_Block(cin, c))
            cin = c
        self.up = nn.ModuleList()
        self.dec = nn.ModuleList()
        for i in range(len(ch) - 1, 0, -1):
            self.up.append(nn.ConvTranspose2d(ch[i], ch[i - 1], 2, stride=2))
            self.dec.append(_Block(ch[i - 1] * 2, ch[i - 1]))
        self.head = nn.Conv2d(ch[0], n_out, 1)

    def forward(self, x):
        skips = []
        for i, blk in enumerate(self.down):
            x = blk(x)
            if i < len(self.down) - 1:
                skips.append(x)
                x = F.max_pool2d(x, 2)
        for up, dec in zip(self.up, self.dec):
            x = up(x)
            x = dec(torch.cat([x, skips.pop()], 1))
        return self.head(x)


def build(arch, pretrained=True):
    if arch == 'resnet34_sa':
        return resnet34_sa(pretrained=pretrained)
    if arch == 'lite':
        return LiteUNet()
    raise ValueError(f'unknown arch {arch}')


class BrowserWrapper(nn.Module):
    """The contract the NeuroKids page expects from any model.

    input  `image`: float32 [N, 1, 512, 512], the paper's preprocessed slice
            (window -100..100 HU -> uint8 -> histogram equalisation) divided by 255.
    output `prob`:  float32 [N, 1, 512, 512], probability of ventricular CSF.

    Channel repeat and ImageNet normalisation (fastai `normalize(imagenet_stats)`)
    happen inside the graph so the page stays model-agnostic.
    """

    def __init__(self, net):
        super().__init__()
        self.net = net
        self.register_buffer('mean', torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor(IMAGENET_STD).view(1, 3, 1, 1))

    def forward(self, image):
        x = (image.repeat(1, 3, 1, 1) - self.mean) / self.std
        return torch.softmax(self.net(x), dim=1)[:, 1:2]
