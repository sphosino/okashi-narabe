"""学習したネットを ONNX に書き出す（ブラウザの ONNX Runtime Web で動かすため。三人将棋の export_onnx.py と同じ考え）。

入力は入力チャンネルそのもの（planes [N,45,9,9]。作るのは engine-rs/core/src/features.rs）。出力は policy [N,1541] と rank [N,3,3] のロジット（補助ヘッドは含めない）。

使い方（okashi-narabe 直下）:
  ../shogi3/python/.venv/Scripts/python.exe python/scripts/export_onnx.py --run r3 --gen 40 --out web/models/r3-gen0040.onnx
"""
import argparse
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from okashiml import model as M  # noqa: E402
from okashiml.features import IN_CHANNELS, planes  # noqa: E402


class Wrapped(torch.nn.Module):
    """入力を 48 チャンネルにふくらませてから通す。
    ONNX Runtime Web 1.30.0 の WebGPU は、入力チャンネルが 4 の倍数でない畳み込み（ここでは 45）の答えを間違える（2026-11-05、CPU との差 8）。
    最初の畳み込みの重みを 0 で 48 チャンネルに広げ、入力も 0 で埋めると CPU と 1e-5 で一致する。"""

    def __init__(self, net):
        super().__init__()
        self.net = net
        c = net.stem[0]
        self.pad = (-c.in_channels) % 4
        self.stem = torch.nn.Conv2d(c.in_channels + self.pad, c.out_channels, 3, padding=1, bias=False)
        with torch.no_grad():
            self.stem.weight.zero_()
            self.stem.weight[:, : c.in_channels] = c.weight

    def forward(self, x):
        net = self.net
        x = torch.nn.functional.pad(x, (0, 0, 0, 0, 0, self.pad))
        h = net.stem[2](net.stem[1](self.stem(x)))
        for b in net.trunk:
            h = b(h)
        p = net.p1(h)
        policy = torch.cat([net.p2(p).flatten(1), net.pg(M.gpool(p))], dim=1)
        v = net.vfc(M.gpool(net.v1(h)))
        return policy, net.rank(v).view(-1, 3, 3)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gen", type=int, required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    net = M.load(os.path.join("runs", a.run, "models", f"gen{a.gen:04d}.pt"), "cpu").eval()
    w = Wrapped(net).eval()
    sample = torch.zeros(2, IN_CHANNELS, 9, 9)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    torch.onnx.export(w, (sample,), a.out, input_names=["planes"], output_names=["policy", "rank"],
                      dynamic_axes={"planes": {0: "n"}, "policy": {0: "n"}, "rank": {0: "n"}}, opset_version=17, dynamo=False)

    # 自己対局の局面で PyTorch と比べる
    import onnxruntime as ort
    shards = sorted(f for f in os.listdir(os.path.join("runs", a.run, "selfplay")) if f.endswith(".npz"))
    st = np.load(os.path.join("runs", a.run, "selfplay", shards[-1]))["states"][:64]
    x = planes(torch.from_numpy(st))
    with torch.no_grad():
        tp, tr = w(x)
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    op, orank = sess.run(None, {"planes": x.numpy()})
    print(f"{a.out}: {os.path.getsize(a.out)/1e6:.1f}MB  PyTorch との差 policy {np.abs(op - tp.numpy()).max():.2e} rank {np.abs(orank - tr.numpy()).max():.2e}")
    for n in (1, 16):
        xb = x[:n].numpy()
        t0 = time.time()
        for _ in range(20):
            sess.run(None, {"planes": xb})
        print(f"  CPU（onnxruntime）でバッチ{n}: {(time.time()-t0)/20*1000:.1f}ms/回")


if __name__ == "__main__":
    main()
