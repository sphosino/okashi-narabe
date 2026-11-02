"""Rust の自己対局ドライバ（okashi_rs.Driver）を PyTorch の推論で回す。"""
import time

import numpy as np
import torch

from .features import STATE_BYTES, planes, utility


@torch.inference_mode()
def evaluate_batch(model, st: torch.Tensor, legal: torch.Tensor):
    """st [B,196] uint8、legal [B,L] int64（-1 は無し）→ priors [B,L], values [B,3]（各席の順位点の見込み）"""
    with torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        out = model(planes(st))
    mask = legal >= 0
    g = out["policy"].float().gather(1, legal.clamp(min=0)).masked_fill(~mask, float("-inf"))
    priors = torch.nan_to_num(torch.softmax(g, dim=1), nan=0.0)
    return priors, utility(out["rank"], st)


def run_driver(driver, models: dict, device, stats: dict | None = None):
    """driver が全セット終わるまで回す。models: {モデル番号: Net}（評価モード・device上）"""
    t0 = time.time()
    n_batches = n_evals = 0
    while True:
        b = driver.next_batch()
        if b is None:
            break
        states_b, legal_b, L, model_b = b
        st = torch.from_numpy(np.frombuffer(states_b, dtype=np.uint8).reshape(-1, STATE_BYTES).copy()).to(device)
        legal = torch.from_numpy(np.frombuffer(legal_b, dtype=np.int32).reshape(-1, L).astype(np.int64)).to(device)
        mids = np.frombuffer(model_b, dtype=np.uint8)
        B = st.shape[0]
        priors = torch.empty(B, L, device=device)
        values = torch.empty(B, 3, device=device)
        for mid in np.unique(mids):
            idx = torch.from_numpy(np.nonzero(mids == mid)[0]).to(device)
            p, v = evaluate_batch(models[int(mid)], st[idx], legal[idx])
            priors[idx] = p
            values[idx] = v
        driver.submit(priors.cpu().numpy().astype(np.float32).tobytes(), values.cpu().numpy().astype(np.float32).tobytes(), L)
        n_batches += 1
        n_evals += B
    if stats is not None:
        dt = time.time() - t0
        stats.update(batches=n_batches, evals=n_evals, seconds=dt, evals_per_sec=n_evals / max(dt, 1e-9))
    return driver.take_finished()
