//! セット形式（docs/ai-plan.md）：同じ3人で何局か続けて指し、各局の点＋勝ちボーナスの合計でセットの順位を決める。
//! 学習の答えはセットの順位点（1位=1、2位=a、3位=0、同点は分け合う）。
//!
//! 探索は局をまたいで読む：局が終わったら、次の局の最初の局面（盤は空、手持ちは元の数、先手は1つずれる）に移る。
//! 終局ノードになるのはセットの最後の局が終わったときだけ。

use crate::*;

/// 合計点は 1/6 点単位の整数で持つ（同点の勝ちボーナスを2人・3人で分けても割り切れるように）
pub const UNIT: i32 = 6;

/// ネットに渡す局面の大きさ（encode を参照）
pub const STATE_BYTES: usize = 196;
/// 方策の番号の数：マスごとに19（置く1・動かす8方向・入れかえ8方向・矢1・いぬ1）× 81、雨、はと
pub const NUM_POLICY: usize = 19 * CELLS + 2;

/// となりの方向（rules.js の DIR8 と同じ順）
pub const DIR8: [(i32, i32); 8] = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)];

#[derive(Clone, Debug)]
pub struct SetConfig {
    pub hand: i32,
    /// 1セットの局数
    pub games: u8,
    /// 局に勝った人の合計に足す点
    pub win_bonus: i32,
    /// 1局目の先手
    pub first: u8,
    /// 席ごとの a（2位の順位点。0〜1）
    pub a: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct SetState {
    pub game: State,
    /// いま何局目か（0から）
    pub game_idx: u8,
    /// セットの合計点（UNIT 倍）
    pub totals: [i32; 3],
    /// セットが終わった
    pub over: bool,
    /// いちばん最近終わった局の最後の点
    pub last_scores: [i32; 3],
}

/// セットのルール（局のルール＋セットの決まり）
pub struct SetRules {
    pub rules: Rules,
    pub set: SetConfig,
}

impl SetRules {
    pub fn new(cfg: Config, set: SetConfig) -> Self {
        SetRules { rules: Rules::new(cfg), set }
    }

    fn game_start(&self, idx: u8, seed: u32) -> State {
        self.rules.new_state(self.set.hand, (self.set.first + idx) % 3, seed.wrapping_add(idx as u32 * 7919))
    }

    /// 終わった局の数
    pub fn games_done(s: &SetState) -> usize {
        s.game_idx as usize + s.over as usize
    }

    pub fn initial(&self, seed: u32) -> SetState {
        SetState { game: self.game_start(0, seed), game_idx: 0, totals: [0; 3], over: false, last_scores: [0; 3] }
    }

    pub fn actions(&self, s: &SetState) -> Vec<Action> {
        if s.over {
            return Vec::new();
        }
        self.rules.actions(&s.game, s.game.turn)
    }

    /// 1手指す。局が終わったら点を合計に足して次の局へ。戻り値の StepInfo はその局の1手の結果
    pub fn step(&self, s: &SetState, a: &Action) -> (SetState, StepInfo) {
        let (g, info) = self.rules.step(&s.game, a);
        let mut ns = SetState { game: g, ..s.clone() };
        if info.end.is_some() {
            self.end_game(&mut ns, &info.winners.clone());
        }
        (ns, info)
    }

    /// 合法手がなくて止まった局（アイテムを使ったあと何もできない、など）を、その時点の点で終える
    pub fn end_stuck(&self, s: &SetState) -> SetState {
        let m = *s.game.scores.iter().max().unwrap();
        let w: Vec<u8> = (0..3u8).filter(|&q| s.game.scores[q as usize] == m).collect();
        let mut ns = s.clone();
        self.end_game(&mut ns, &w);
        ns
    }

    fn end_game(&self, ns: &mut SetState, winners: &[u8]) {
        ns.last_scores = ns.game.scores;
        for q in 0..3 {
            ns.totals[q] += ns.game.scores[q] * UNIT;
        }
        if !winners.is_empty() {
            let share = self.set.win_bonus * UNIT / winners.len() as i32;
            for &w in winners {
                ns.totals[w as usize] += share;
            }
        }
        if ns.game_idx + 1 >= self.set.games {
            ns.over = true;
        } else {
            ns.game_idx += 1;
            ns.game = self.game_start(ns.game_idx, ns.game.seed);
        }
    }

    /// セットの順位（0=1位, 1=2位, 2=3位）を、同点は分け合った形で返す：rank_share[q][r] = q が r 位である割合
    pub fn rank_share(totals: &[i32; 3]) -> [[f32; 3]; 3] {
        let mut out = [[0f32; 3]; 3];
        for q in 0..3 {
            let above = (0..3).filter(|&o| totals[o] > totals[q]).count();
            let same = (0..3).filter(|&o| totals[o] == totals[q]).count();
            for r in above..above + same {
                out[q][r] = 1.0 / same as f32;
            }
        }
        out
    }

    /// セットが終わったときの各席の順位点（席ごとの a で）
    pub fn utility(&self, totals: &[i32; 3]) -> [f32; 3] {
        let rs = Self::rank_share(totals);
        let mut u = [0f32; 3];
        for q in 0..3 {
            u[q] = rs[q][0] + self.set.a[q] * rs[q][1];
        }
        u
    }

    /// 方策の番号（9×9 にそろえたマスで数える）
    pub fn policy_index(&self, a: &Action) -> usize {
        let n = self.rules.cfg.size;
        let pad = |i: u8| (i as usize / n) * MAX_SIZE + i as usize % n;
        let dir = |from: u8, to: u8| {
            let (dr, dc) = ((to as usize / n) as i32 - (from as usize / n) as i32, (to as usize % n) as i32 - (from as usize % n) as i32);
            DIR8.iter().position(|&d| d == (dr, dc)).unwrap()
        };
        match *a {
            Action::Place { to } => pad(to),
            Action::Move { from, to } => (1 + dir(from, to)) * CELLS + pad(from),
            Action::Swap { from, to } => (9 + dir(from, to)) * CELLS + pad(from),
            Action::Item { k: Item::Arrow, to } => 17 * CELLS + pad(to.unwrap()),
            Action::Item { k: Item::Dog, to } => 18 * CELLS + pad(to.unwrap()),
            Action::Item { k: Item::Rain, .. } => 19 * CELLS,
            Action::Item { k: Item::Dove, .. } => 19 * CELLS + 1,
        }
    }

    /// ネットに渡す局面（STATE_BYTES バイト。入力チャンネルへの展開は Python 側）
    ///   0..81    マス（9×9にそろえる）：0/1/2 = 誰のお菓子か、3 = 空き、4 = 盤の外
    ///   81..162  恋モード（0/1）
    ///   162..165 手持ち / 165..168 この局の点 / 168..174 セットの合計点（UNIT 倍、u16 LE ×3）
    ///   174 手番 / 175..177 手数（u16 LE）
    ///   177 盤の大きさ / 178 並べる数 / 179 目標点 / 180 恋ボーナス / 181 時間切れの手数 / 182 わいわい
    ///   183..186 各人のアイテム（0=なし 1..4）/ 186 箱のマス（9×9、255=なし）/ 187 箱の中身（1..4）
    ///   188 何局制か / 189 いま何局目か / 190 勝ちボーナス / 191..194 席ごとの a（×100）/ 194 手持ちの元の数 / 195 予備
    pub fn encode(&self, s: &SetState, out: &mut Vec<u8>) {
        let cfg = &self.rules.cfg;
        let n = cfg.size;
        let g = &s.game;
        let item_id = |k: Option<Item>| k.map_or(0u8, |k| ITEMS.iter().position(|&x| x == k).unwrap() as u8 + 1);
        let start = out.len();
        out.resize(start + STATE_BYTES, 0);
        let o = &mut out[start..];
        for r in 0..MAX_SIZE {
            for c in 0..MAX_SIZE {
                let i = r * MAX_SIZE + c;
                o[i] = if r >= n || c >= n {
                    4
                } else {
                    let v = g.cells[r * n + c];
                    if v == EMPTY {
                        3
                    } else {
                        v
                    }
                };
            }
        }
        for &f in &g.fixed {
            o[81 + (f as usize / n) * MAX_SIZE + f as usize % n] = 1;
        }
        for q in 0..3 {
            o[162 + q] = g.hands[q].clamp(0, 255) as u8;
            o[165 + q] = g.scores[q].clamp(0, 255) as u8;
            o[168 + q * 2..170 + q * 2].copy_from_slice(&(s.totals[q].clamp(0, 65535) as u16).to_le_bytes());
            o[183 + q] = item_id(g.items[q]);
            o[191 + q] = (self.set.a[q] * 100.0).round() as u8;
        }
        o[174] = g.turn;
        o[175..177].copy_from_slice(&(g.moves.min(65535) as u16).to_le_bytes());
        o[177] = n as u8;
        o[178] = cfg.need as u8;
        o[179] = cfg.target as u8;
        o[180] = cfg.love_bonus as u8;
        o[181] = cfg.max_moves.min(255) as u8;
        o[182] = cfg.party as u8;
        match g.bx {
            Some((at, k)) => {
                o[186] = ((at as usize / n) * MAX_SIZE + at as usize % n) as u8;
                o[187] = item_id(Some(k));
            }
            None => o[186] = 255,
        }
        o[188] = self.set.games;
        o[189] = s.game_idx;
        o[190] = self.set.win_bonus as u8;
        o[194] = self.set.hand as u8;
    }
}
