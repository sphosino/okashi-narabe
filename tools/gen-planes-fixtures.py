"""Rust の features.rs（ブラウザ版の入力作り）を Python の features.planes と照合するデータを作る。
  ../shogi3/python/.venv/Scripts/python.exe tools/gen-planes-fixtures.py runs/r3/selfplay/gen0010.npz
自己対局の局面から 2000 個を選び（4つに1つはアイテムと箱を足す）、局面（196 バイト）と入力（45×81 の float32）を engine-rs/core/tests/fixtures/ に書く。
"""
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
from okashiml.features import planes  # noqa: E402

d = np.load(sys.argv[1])
st = d["states"]
idx = np.random.default_rng(1).choice(len(st), min(2000, len(st)), replace=False)
st = st[idx].copy()
# 自己対局はわいわいなしなので、4つに1つはアイテムと箱を手で入れる（入力作りの照合のためだけ。ありえない配置でもよい）
r = np.random.default_rng(2)
for i in range(0, len(st), 4):
    st[i, 182] = 1
    st[i, 183:186] = r.integers(0, 5, 3)
    st[i, 186], st[i, 187] = (r.integers(0, 81), r.integers(1, 5)) if r.random() < 0.7 else (255, 0)
pl = planes(torch.from_numpy(st)).numpy().astype(np.float32)
out = os.path.join(os.path.dirname(__file__), "..", "engine-rs", "core", "tests", "fixtures")
os.makedirs(out, exist_ok=True)
st.tofile(os.path.join(out, "planes_states.bin"))
pl.tofile(os.path.join(out, "planes.bin"))
print(f"{len(st)}局面を {out} に書いた（盤の大きさ {sorted(set(st[:, 177].tolist()))}、恋 {int((st[:, 81:162] > 0).any(1).sum())}局面）")
