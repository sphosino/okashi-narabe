"""ネット本体（三人将棋の shogi3ml/model.py と同じ形を小さくしたもの）。

残差ネット＋グローバルプーリングのブロック（KataGo 式）。出力：
  policy     : [N, 1541] 手番の人の方策のロジット（マスごとに19 × 81、雨、はと。set.rs の policy_index）
  rank       : [N, 3, 3] 手番から見た各席の、セットの最終順位のロジット
  game_score : [N, 3]    手番から見た各席の、この局の最後の点 ÷ 目標点（補助）
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

from .features import IN_CHANNELS


def gpool(x):
    return torch.cat([x.mean(dim=(2, 3)), x.amax(dim=(2, 3))], dim=1)


class ResBlock(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        return F.relu(x + self.b2(self.c2(y)))


class GlobalPoolBlock(nn.Module):
    def __init__(self, ch: int, gp_ch: int = 16):
        super().__init__()
        self.gp_ch = gp_ch
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch - gp_ch)
        self.bg = nn.BatchNorm2d(gp_ch)
        self.fc = nn.Linear(gp_ch * 2, ch - gp_ch)
        self.c2 = nn.Conv2d(ch - gp_ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = self.c1(x)
        reg, g = y[:, : -self.gp_ch], y[:, -self.gp_ch :]
        g = F.relu(self.bg(g))
        reg = F.relu(self.b1(reg) + self.fc(gpool(g))[:, :, None, None])
        return F.relu(x + self.b2(self.c2(reg)))


class Net(nn.Module):
    def __init__(self, blocks: int = 6, ch: int = 64, gp_blocks=None):
        super().__init__()
        if gp_blocks is None:
            gp_blocks = (blocks // 3, 2 * blocks // 3)
        self.config = dict(blocks=blocks, ch=ch, gp_blocks=tuple(gp_blocks))
        self.stem = nn.Sequential(nn.Conv2d(IN_CHANNELS, ch, 3, padding=1, bias=False), nn.BatchNorm2d(ch), nn.ReLU())
        self.trunk = nn.ModuleList([GlobalPoolBlock(ch) if i in gp_blocks else ResBlock(ch) for i in range(blocks)])
        self.p1 = nn.Sequential(nn.Conv2d(ch, 32, 1, bias=False), nn.BatchNorm2d(32), nn.ReLU())
        self.p2 = nn.Conv2d(32, 19, 1)
        self.pg = nn.Linear(64, 2)  # 雨・はと（マスのないアイテム）
        self.v1 = nn.Sequential(nn.Conv2d(ch, 32, 1, bias=False), nn.BatchNorm2d(32), nn.ReLU())
        self.vfc = nn.Sequential(nn.Linear(64, 128), nn.ReLU())
        self.rank = nn.Linear(128, 9)
        self.game_score = nn.Linear(128, 3)

    def forward(self, x):
        h = self.stem(x)
        for b in self.trunk:
            h = b(h)
        p = self.p1(h)
        policy = torch.cat([self.p2(p).flatten(1), self.pg(gpool(p))], dim=1)
        v = self.vfc(gpool(self.v1(h)))
        return {"policy": policy, "rank": self.rank(v).view(-1, 3, 3), "game_score": self.game_score(v)}


def save(model: Net, path, extra=None):
    torch.save({"config": model.config, "state": model.state_dict(), "extra": extra or {}}, path)


def load(path, device="cpu") -> Net:
    ck = torch.load(path, map_location=device, weights_only=False)
    m = Net(**ck["config"])
    m.load_state_dict(ck["state"])
    return m.to(device)
