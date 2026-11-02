"""自己対局 → 学習 → 評価 のループ（三人将棋の train_loop.py を小さくしたもの。計画は docs/ai-plan.md）。

使い方（okashi-narabe 直下。PyTorch は三人将棋の環境を借りる）:
  ../shogi3/python/.venv/Scripts/python.exe python/scripts/train_loop.py --run t1 --gens 10

runs/<run>/ に、学習データ（selfplay/）、モデル（models/）、評価結果（eval.jsonl）、ログ（log.txt）を置く。
途中で止めても、最後に保存した世代から再開する。世代0はランダムな重みのネット。
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import okashi_rs  # noqa: E402
from okashiml import data as D  # noqa: E402
from okashiml import model as M  # noqa: E402
from okashiml.selfplay import run_driver  # noqa: E402
from okashiml.train import train_steps  # noqa: E402


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gens", type=int, default=10, help="この実行で進める世代数")
    p.add_argument("--sets-per-gen", type=int, default=400)
    p.add_argument("--parallel", type=int, default=400, help="同時に進めるセット数（推論のバッチの大きさ）")
    p.add_argument("--visits-full", type=int, default=400)
    p.add_argument("--visits-fast", type=int, default=80)
    p.add_argument("--full-prob", type=float, default=0.25)
    p.add_argument("--temp-plies", type=int, default=8, help="各局の最初のこの手数は、訪問数に比例して手を選ぶ")
    p.add_argument("--train-ratio", type=float, default=1.0, help="1世代の学習サンプル数 ÷ 新しく増えた局面数")
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--window", type=int, default=300_000, help="学習に使う直近の局面数")
    p.add_argument("--blocks", type=int, default=6)
    p.add_argument("--ch", type=int, default=64)
    p.add_argument("--eval-every", type=int, default=2)
    p.add_argument("--eval-sets", type=int, default=90)
    p.add_argument("--eval-visits", type=int, default=200)
    p.add_argument("--eval-vs", nargs="+", default=["prev", "cpu:hard"],
                   help="評価の相手（2席）: prev（eval_every世代前）/ gen:N / cpu:easy|normal|hard（今のCPU）/ random / mcts:訪問数（ランダム評価のMCTS）")
    # ルールのくじ引き（engine-rs/py の Driver と同じ）
    p.add_argument("--sizes", type=int, nargs="+", default=[5, 6, 7, 8, 9])
    p.add_argument("--need5-prob", type=float, default=0.3)
    p.add_argument("--hand", type=int, nargs=2, default=[4, 10])
    p.add_argument("--target", type=int, nargs=2, default=[2, 4])
    p.add_argument("--love-prob", type=float, default=0.8)
    p.add_argument("--party-prob", type=float, default=0.0)
    p.add_argument("--games", type=int, nargs="+", default=[1, 3])
    p.add_argument("--bonus", type=int, nargs="+", default=[0, 1, 2, 3])
    p.add_argument("--a-values", type=float, nargs="+", default=[0.0])
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return p.parse_args()


def rule_kw(a):
    return dict(sizes=a.sizes, need5_prob=a.need5_prob, hand=tuple(a.hand), target=tuple(a.target), love_prob=a.love_prob,
                party_prob=a.party_prob, games=a.games, bonus=a.bonus, a_values=a.a_values)


def main():
    a = parse()
    root = os.path.join("runs", a.run)
    for sub in ("models", "selfplay"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    logf = open(os.path.join(root, "log.txt"), "a", encoding="utf-8")

    def log(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    mpath = lambda g: os.path.join(root, "models", f"gen{g:04d}.pt")
    gens = sorted(int(os.path.basename(p)[3:7]) for p in glob.glob(os.path.join(root, "models", "gen*.pt")))
    dev = torch.device(a.device)
    if not gens:
        torch.manual_seed(a.seed)
        M.save(M.Net(blocks=a.blocks, ch=a.ch), mpath(0))
        gens = [0]
    gen = gens[-1]
    model = M.load(mpath(gen), dev).eval()
    opt = torch.optim.SGD(model.parameters(), lr=a.lr, momentum=0.9, weight_decay=a.weight_decay, nesterov=True)
    scaler = torch.amp.GradScaler(enabled=dev.type == "cuda")
    rng = np.random.default_rng(a.seed + gen)
    log(f"run {a.run}：世代{gen}から {a.gens} 世代。{vars(a)}")

    for _ in range(a.gens):
        # 自己対局
        t0 = time.time()
        drv = okashi_rs.Driver(a.parallel, a.sets_per_gen, ["net:0"] * 3, record=True, visits_full=a.visits_full,
                               visits_fast=a.visits_fast, full_prob=a.full_prob, temp_plies=a.temp_plies,
                               seed=a.seed * 100_003 + gen, **rule_kw(a))
        stats = {}
        d = D.decode(run_driver(drv, {0: model}, dev, stats))
        D.save(os.path.join(root, "selfplay", f"gen{gen:04d}.npz"), d)
        n_new = len(d["states"])
        log(f"世代{gen} 自己対局：{len(d['g_id'])}セット・{n_new}局面・1セット平均 {d['g_plies'].mean():.0f}手 "
            f"（{time.time()-t0:.0f}秒、{stats['evals_per_sec']:.0f}評価/秒）")

        # 学習（直近の局面 window ぶん）
        shards, total = [], 0
        for p in sorted(glob.glob(os.path.join(root, "selfplay", "gen*.npz")), reverse=True):
            s = D.load(p)
            shards.append(s)
            total += len(s["states"])
            if total >= a.window:
                break
        win = D.Window(shards[::-1])
        steps = max(1, int(a.train_ratio * n_new / a.batch))
        t0 = time.time()
        m = train_steps(model, opt, scaler, win, steps, a.batch, dev, rng)
        gen += 1
        M.save(model, mpath(gen))
        log(f"世代{gen} 学習：{steps}ステップ（窓 {len(win)}局面、{time.time()-t0:.0f}秒） " + " ".join(f"{k}={v:.3f}" for k, v in m.items()))

        # 評価：新しい世代1席 vs 相手2席（席はセットごとに回す）
        if gen % a.eval_every == 0:
            for vs in a.eval_vs:
                models = {0: model}
                if vs == "prev" or vs.startswith("gen:"):
                    og = max(0, gen - a.eval_every) if vs == "prev" else int(vs[4:])
                    models[1] = M.load(mpath(og), dev).eval()
                    other, name = "net:1", f"gen{og}"
                else:
                    other, name = vs, vs
                t0 = time.time()
                drv = okashi_rs.Driver(min(a.parallel, a.eval_sets), a.eval_sets, ["net:0", other, other], rotate=True, record=False,
                                       visits_full=a.eval_visits, full_prob=1.0, temp_plies=0, dirichlet_total=0.0,
                                       seed=999_983 + gen, **rule_kw(a))
                e = D.decode(run_driver(drv, models, dev))
                u = e["g_utility"][e["g_seat_net"] == 0]
                res = dict(gen=gen, vs=name, sets=len(u), score=float(u.mean()), seconds=round(time.time() - t0))
                log(f"世代{gen} 評価 vs {name}：順位点の平均 {res['score']*100:.1f}%（互角なら33%、{len(u)}セット）")
                with open(os.path.join(root, "eval.jsonl"), "a", encoding="utf-8") as f:
                    f.write(json.dumps(res, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
