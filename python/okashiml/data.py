"""学習データのシャード（1世代の自己対局の出力）の保存・読み込みと、バッチの作成。

シャードは npz。1局面1行（engine-rs/py の take_finished と同じ）：
  states [N,196] u8 / policy_offsets [N+1] i64 / policy_index [M] i32 / policy_visits [M] u32 / full [N] u8
  rank [N,3,3] f32（各席の最終順位の割合）/ root_value [N,3] f32 / game_score [N,3] u8 / set_id [N] u32
セットの要約（g_*）も同じファイルに入れる（分析用）。
"""
import numpy as np
import torch

from .features import NUM_POLICY, STATE_BYTES
from .features import rel_seats

_DTYPES = {
    "states": (np.uint8, (-1, STATE_BYTES)),
    "policy_offsets": (np.int64, (-1,)),
    "policy_index": (np.int32, (-1,)),
    "policy_visits": (np.uint32, (-1,)),
    "full": (np.uint8, (-1,)),
    "rank": (np.float32, (-1, 3, 3)),
    "root_value": (np.float32, (-1, 3)),
    "game_score": (np.uint8, (-1, 3)),
    "set_id": (np.uint32, (-1,)),
    "g_id": (np.uint32, (-1,)),
    "g_totals": (np.int32, (-1, 3)),
    "g_utility": (np.float32, (-1, 3)),
    "g_seat_net": (np.uint8, (-1, 3)),
    "g_plies": (np.uint32, (-1,)),
    "g_cfg": (np.uint8, (-1, 12)),
}


def decode(d: dict) -> dict:
    """Driver.take_finished() の bytes の dict → numpy の dict"""
    return {k: np.frombuffer(v, dtype=_DTYPES[k][0]).reshape(_DTYPES[k][1]).copy() for k, v in d.items()}


def save(path, d: dict):
    np.savez_compressed(path, **d)


def load(path) -> dict:
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


class Window:
    """直近のシャードを並べて、ランダムにバッチを取り出す"""

    def __init__(self, shards: list[dict]):
        self.states = np.concatenate([s["states"] for s in shards])
        self.full = np.concatenate([s["full"] for s in shards])
        self.rank = np.concatenate([s["rank"] for s in shards])
        self.game_score = np.concatenate([s["game_score"] for s in shards])
        offs, idx, vis, base = [], [], [], 0
        for s in shards:
            o = s["policy_offsets"]
            offs.append(o[:-1] + base)
            idx.append(s["policy_index"])
            vis.append(s["policy_visits"])
            base += o[-1]
        self.p_start = np.concatenate(offs)
        self.p_len = np.concatenate([np.diff(s["policy_offsets"]) for s in shards])
        self.p_index = np.concatenate(idx)
        self.p_visits = np.concatenate(vis).astype(np.float32)

    def __len__(self):
        return len(self.states)

    def sample(self, rng: np.random.Generator, batch: int, device) -> dict:
        rows = rng.integers(0, len(self), batch)
        policy = np.zeros((batch, NUM_POLICY), dtype=np.float32)
        for i, r in enumerate(rows):
            a, n = self.p_start[r], self.p_len[r]
            if n:
                v = self.p_visits[a : a + n]
                policy[i, self.p_index[a : a + n]] = v / max(v.sum(), 1.0)
        st = torch.from_numpy(self.states[rows]).to(device)
        seats = rel_seats(st[:, 174].long())
        rank = torch.from_numpy(self.rank[rows]).to(device)  # [B,3(絶対),3]
        gs = torch.from_numpy(self.game_score[rows].astype(np.float32)).to(device)
        target = st[:, 179].float().clamp(min=1)[:, None]
        return {
            "states": st,
            "policy": torch.from_numpy(policy).to(device),
            "policy_w": torch.from_numpy(self.full[rows].astype(np.float32)).to(device),
            "rank": rank.gather(1, seats[:, :, None].expand(-1, -1, 3)),  # 手番から見た席の順に
            "game_score": gs.gather(1, seats) / target,
        }
