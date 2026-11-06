"""ある世代を相手（CPU など）2席と多めのセットで当て、ルールごとの順位点を出す。

使い方（okashi-narabe 直下）:
  ../shogi3/python/.venv/Scripts/python.exe python/scripts/eval_cpu.py --run r1 --gen 20 --vs cpu:hard --sets 600
"""
import argparse
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import okashi_rs  # noqa: E402
from okashiml import data as D  # noqa: E402
from okashiml import model as M  # noqa: E402
from okashiml.selfplay import run_driver  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gen", type=int, required=True)
    p.add_argument("--vs", default="cpu:hard")
    p.add_argument("--sets", type=int, default=600)
    p.add_argument("--parallel", type=int, default=300)
    p.add_argument("--visits", type=int, default=200)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--games", type=int, nargs="+", default=[1, 3], help="セットの局数のくじ引き（学習と同じにそろえる）")
    a = p.parse_args()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    models = {0: M.load(os.path.join("runs", a.run, "models", f"gen{a.gen:04d}.pt"), dev).eval()}
    other = a.vs
    if a.vs.startswith("gen:"):
        models[1] = M.load(os.path.join("runs", a.run, "models", f"gen{int(a.vs[4:]):04d}.pt"), dev).eval()
        other = "net:1"
    drv = okashi_rs.Driver(min(a.parallel, a.sets), a.sets, ["net:0", other, other], rotate=True, record=False,
                           visits_full=a.visits, full_prob=1.0, temp_plies=0, dirichlet_total=0.0, seed=a.seed, games=a.games)
    e = D.decode(run_driver(drv, models, dev))
    u = e["g_utility"][e["g_seat_net"] == 0]
    cfg = e["g_cfg"]
    se = u.std() / np.sqrt(len(u))
    print(f"世代{a.gen} vs {a.vs}×2：順位点の平均 {u.mean()*100:.1f}% ±{se*100:.1f}（互角なら33%、{len(u)}セット）")
    seat = np.argmax(e["g_seat_net"] == 0, axis=1)
    groups = [("盤", cfg[:, 0]), ("並べる数", cfg[:, 1]), ("手持ち", cfg[:, 2]), ("目標点", cfg[:, 3]), ("恋ボーナス", cfg[:, 4]),
              ("局数", cfg[:, 6]), ("勝ちボーナス", cfg[:, 7]), ("学習AIの席（1局目の先手から）", (seat - cfg[:, 8]) % 3)]
    for name, col in groups:
        parts = [f"{v}: {u[col == v].mean()*100:.0f}%（{(col == v).sum()}）" for v in np.unique(col)]
        print(f"  {name}  " + " / ".join(parts))


if __name__ == "__main__":
    main()
