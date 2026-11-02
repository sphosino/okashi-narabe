"""局面（196バイトの形）→ ネットの入力チャンネル。GPU上で作る。

局面の形は engine-rs/core/src/set.rs の encode と同じ。盤は9×9にそろえてある。
席は手番の人から見た順（0=自分、1=次の人、2=その次）に並べかえる。盤は回さない（どの席も同じ盤なので）。

入力チャンネル（9×9）：
  お菓子 3（自分・次・その次）/ 空き 1 / 盤の外 1 / 恋モード 3（持ち主ごと）/ アイテム箱 4（中身ごと）
  全体の値 33（盤全体に広げる）：手持ち3・この局の点3・セットの合計点3・アイテム12・ルール6・セット5・自分の a 1
相手の a は見せない（実際の対局でも見えないため。docs/ai-plan.md）。
"""
import torch
import torch.nn.functional as F

STATE_BYTES = 196
NUM_POLICY = 19 * 81 + 2
UNIT = 6  # 合計点は 1/6 点単位
IN_CHANNELS = 12 + 33


def rel_seats(turn: torch.Tensor) -> torch.Tensor:
    """turn [N] → 手番から見た j 番目の席の絶対番号 [N,3]"""
    return (turn[:, None] + torch.arange(3, device=turn.device)[None, :]) % 3


def planes(st: torch.Tensor) -> torch.Tensor:
    """st: uint8 [N,196] → float [N,45,9,9]"""
    n = st.shape[0]
    s = st.long()
    turn = s[:, 174]
    seats = rel_seats(turn)
    cells = s[:, :81]
    piece = cells < 3
    rel_owner = torch.where(piece, (cells - turn[:, None]) % 3, torch.full_like(cells, 3))
    own = F.one_hot(rel_owner, 4)[..., :3].float()  # [N,81,3]
    empty = (cells == 3).float()[..., None]
    off = (cells == 4).float()[..., None]
    love = own * s[:, 81:162, None].float()
    box = torch.zeros(n, 81, 4, device=st.device)
    has_box = s[:, 186] < 81
    if has_box.any():
        idx = torch.nonzero(has_box)[:, 0]
        box[idx, s[idx, 186], (s[idx, 187] - 1).clamp(0, 3)] = 1.0
    spatial = torch.cat([own, empty, off, love, box], dim=2).permute(0, 2, 1).reshape(n, 12, 9, 9)

    def rel(at):
        return s[:, at : at + 3].gather(1, seats).float()

    target = s[:, 179].float().clamp(min=1)
    totals = (s[:, 168:174:2] + s[:, 169:174:2] * 256).gather(1, seats).float() / UNIT
    items = F.one_hot(s[:, 183:186].gather(1, seats), 5)[..., 1:].float().reshape(n, 12)
    games = s[:, 188].float()
    a_self = s[:, 191:194].gather(1, turn[:, None]).float() / 100.0
    glob = torch.cat(
        [
            rel(162) / 10.0,
            rel(165) / target[:, None],
            totals / 20.0,
            items,
            torch.stack([target / 5.0, (s[:, 178] == 5).float(), s[:, 180].float(), s[:, 182].float(), s[:, 177].float() / 9.0,
                         (s[:, 175] + s[:, 176] * 256).float() / 150.0], dim=1),
            torch.stack([games / 11.0, s[:, 189].float() / 11.0, (games - s[:, 189].float()) / 11.0, s[:, 190].float() / 3.0,
                         s[:, 194].float() / 10.0], dim=1),
            a_self,
        ],
        dim=1,
    )
    return torch.cat([spatial, glob.view(n, 33, 1, 1).expand(n, 33, 9, 9)], dim=1)


def utility(rank_logits: torch.Tensor, st: torch.Tensor) -> torch.Tensor:
    """順位の予想 [N,3(手番から見た席),3(順位)] → 各席（絶対）の順位点の見込み [N,3]。a は席ごとの値を使う"""
    p = torch.softmax(rank_logits.float(), dim=2)
    seats = rel_seats(st[:, 174].long())
    a = st[:, 191:194].long().gather(1, seats).float() / 100.0
    u_rel = p[:, :, 0] + a * p[:, :, 1]
    return torch.zeros_like(u_rel).scatter(1, seats, u_rel)
