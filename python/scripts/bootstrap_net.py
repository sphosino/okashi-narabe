"""大きさの違うネットを、前の run の自己対局の局面で学習させて、新しい run の最初の世代にする。

前の run の最後の selfplay（--copy 世代ぶん）を新しい run にコピーし、そのうち最後の1世代を確かめ用に残して、
残りで --steps ステップ学習する（学習率は --lr から --lr-end へ、cos で下げる）。
確かめ用の局面で、前の run の最後の世代と損失を比べて出す。
新しい run の世代番号は前の run から続ける（--gen）。比べる相手の世代（--ref）も新しい run の models/ にコピーする。

  ../shogi3/python/.venv/Scripts/python.exe python/scripts/bootstrap_net.py --src r3 --dst r4 --gen 250 --blocks 15 --ch 160
"""
import argparse
import glob
import math
import os
import shutil
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from okashiml import data as D  # noqa: E402
from okashiml import model as M  # noqa: E402
from okashiml.train import losses, train_steps  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--dst", required=True)
    p.add_argument("--gen", type=int, required=True, help="前の run の最後の世代（新しい run もこの番号で始める）")
    p.add_argument("--ref", type=int, nargs="*", default=[100], help="新しい run の models/ にもコピーする、前の run の世代")
    p.add_argument("--copy", type=int, default=30, help="コピーする selfplay の世代数")
    p.add_argument("--blocks", type=int, default=15)
    p.add_argument("--ch", type=int, default=160)
    p.add_argument("--steps", type=int, default=20000)
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--lr-end", type=float, default=0.002)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--seed", type=int, default=1)
    a = p.parse_args()

    src, dst = os.path.join("runs", a.src), os.path.join("runs", a.dst)
    for sub in ("models", "selfplay"):
        os.makedirs(os.path.join(dst, sub), exist_ok=True)
    if glob.glob(os.path.join(dst, "models", f"gen{a.gen:04d}.pt")):
        sys.exit(f"{dst}/models/gen{a.gen:04d}.pt はもうある")
    logf = open(os.path.join(dst, "log.txt"), "a", encoding="utf-8")

    def log(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    log(f"bootstrap {a.src} 世代{a.gen} → {a.dst}：{vars(a)}")
    names = [f"gen{g:04d}.npz" for g in range(a.gen - a.copy, a.gen)]
    for n in names:
        shutil.copy2(os.path.join(src, "selfplay", n), os.path.join(dst, "selfplay", n))
    for g in a.ref:
        shutil.copy2(os.path.join(src, "models", f"gen{g:04d}.pt"), os.path.join(dst, "models", f"gen{g:04d}.pt"))

    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    shards = [D.load(os.path.join(dst, "selfplay", n)) for n in names]
    train, val = D.Window(shards[:-1]), D.Window(shards[-1:])
    log(f"学習 {len(train)}局面 / 確かめ {len(val)}局面（{names[-1]}）")

    def val_loss(model):
        model.eval()
        rng = np.random.default_rng(12345)
        hist = []
        with torch.no_grad():
            for _ in range(40):
                L = losses(model, val.sample(rng, 512, dev))
                hist.append({k: float(v) for k, v in L.items()})
        return " ".join(f"{k}={np.mean([h[k] for h in hist]):.3f}" for k in hist[0])

    old = M.load(os.path.join(src, "models", f"gen{a.gen:04d}.pt"), dev).eval()
    log(f"前の run の世代{a.gen}（{old.config}）の確かめ損失：{val_loss(old)}")

    torch.manual_seed(a.seed)
    model = M.Net(blocks=a.blocks, ch=a.ch).to(dev)
    opt = torch.optim.SGD(model.parameters(), lr=a.lr, momentum=0.9, weight_decay=a.weight_decay, nesterov=True)
    scaler = torch.amp.GradScaler(enabled=dev.type == "cuda")
    rng = np.random.default_rng(a.seed)
    chunk = 1000
    t0 = time.time()
    for done in range(0, a.steps, chunk):
        lr = a.lr_end + (a.lr - a.lr_end) * 0.5 * (1 + math.cos(math.pi * done / a.steps))
        for g in opt.param_groups:
            g["lr"] = lr
        m = train_steps(model, opt, scaler, train, min(chunk, a.steps - done), a.batch, dev, rng)
        log(f"  {done + chunk}/{a.steps} lr={lr:.4f} 学習 " + " ".join(f"{k}={v:.3f}" for k, v in m.items())
            + f" ／ 確かめ {val_loss(model)}（{time.time() - t0:.0f}秒）")
    M.save(model, os.path.join(dst, "models", f"gen{a.gen:04d}.pt"))
    log(f"{dst}/models/gen{a.gen:04d}.pt を保存（{model.config}）")


if __name__ == "__main__":
    main()
