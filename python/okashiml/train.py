"""損失と学習ステップ（三人将棋の shogi3ml/train.py を小さくしたもの）。"""
import numpy as np
import torch
import torch.nn.functional as F

from .features import planes

WEIGHTS = dict(policy=1.0, rank=1.5, game_score=0.3)


def losses(model, b: dict) -> dict:
    st = b["states"]
    with torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        out = model(planes(st))
    L = {}
    # 方策：全力探索の局面だけ
    logp = F.log_softmax(out["policy"].float(), dim=1)
    w = b["policy_w"]
    L["policy"] = (-(b["policy"] * logp).sum(dim=1) * w).sum() / w.sum().clamp(min=1.0)
    # セットの最終順位（同点は分け合ったソフトラベル）
    L["rank"] = -(b["rank"] * F.log_softmax(out["rank"].float(), dim=2)).sum(dim=2).mean()
    L["game_score"] = F.huber_loss(out["game_score"].float(), b["game_score"])
    L["total"] = sum(WEIGHTS[k] * L[k] for k in WEIGHTS)
    with torch.no_grad():
        # 監視用：1位の当たり（手番の人が1位になるかの予想が、多数側と合っているか）
        L["self_first_acc"] = ((out["rank"][:, 0, 0] > 0.0) == (b["rank"][:, 0, 0] > 0.5)).float().mean()
    return L


def train_steps(model, opt, scaler, window, steps: int, batch: int, device, rng: np.random.Generator, log=None):
    model.train()
    hist = []
    for s in range(steps):
        b = window.sample(rng, batch, device)
        L = losses(model, b)
        opt.zero_grad(set_to_none=True)
        scaler.scale(L["total"]).backward()
        scaler.step(opt)
        scaler.update()
        hist.append({k: float(v.detach()) for k, v in L.items()})
        if log and (s + 1) % 200 == 0:
            m = {k: np.mean([h[k] for h in hist[-200:]]) for k in hist[-1]}
            log(f"  step {s+1}/{steps} " + " ".join(f"{k}={v:.3f}" for k, v in m.items()))
    model.eval()
    return {k: float(np.mean([h[k] for h in hist])) for k in hist[-1]} if hist else {}
