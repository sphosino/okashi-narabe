//! おかしならべのルールエンジン。rules.js をそのまま写したもの（tests/js_fixtures.rs で照合）。
//!
//! - マス：i = 行*size + 列（rules.js と同じ。盤は最大 9×9）
//! - cells：0/1/2（誰のお菓子か）か EMPTY
//! - fixed：恋モードのお菓子がいるマス（rules.js と同じ並び順を保つ）
//! - 状態は書きかえず、いつも新しい状態を返す
//! - セット形式・ネットに渡す形・方策の番号は set.rs、ネットの入力チャンネルは features.rs

pub mod set;
pub use set::*;
pub mod features;
pub use features::{planes, IN_CHANNELS, PLANES_LEN};

pub const EMPTY: u8 = 255;
pub const MAX_MOVES: u32 = 150;
/// わいわい：盤に箱がないとき、この手数ごとに空きマスへ落ちてくる
pub const SPAWN: u32 = 4;
pub const MAX_SIZE: usize = 9;
pub const CELLS: usize = MAX_SIZE * MAX_SIZE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    /// キューピッドの矢：自分のお菓子1つを恋モードに
    Arrow,
    /// いぬ：相手のお菓子1つを持ち主の手持ちに返す
    Dog,
    /// 失恋の雨：盤の恋モードを全部とく
    Rain,
    /// はと：自分の手持ちが1つ増える
    Dove,
}
pub const ITEMS: [Item; 4] = [Item::Arrow, Item::Dog, Item::Rain, Item::Dove];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Place { to: u8 },
    Move { from: u8, to: u8 },
    Swap { from: u8, to: u8 },
    Item { k: Item, to: Option<u8> },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub size: usize,
    pub need: usize,
    pub target: i32,
    pub love_bonus: bool,
    pub max_moves: u32,
    pub party: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub cells: [u8; CELLS],
    pub hands: [i32; 3],
    pub scores: [i32; 3],
    pub fixed: Vec<u8>,
    pub turn: u8,
    pub moves: u32,
    /// わいわい：各プレイヤーが持っているアイテム（1つまで）
    pub items: [Option<Item>; 3],
    /// わいわい：盤に落ちているアイテム箱（マス, 中身）
    pub bx: Option<(u8, Item)>,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    Win,
    Timeout,
    Stuck,
}

/// 1手の結果
#[derive(Clone, Debug, Default)]
pub struct StepInfo {
    pub end: Option<EndReason>,
    pub winners: Vec<u8>,
    /// 動けずにパスになった人
    pub skipped: Vec<u8>,
    /// 入れかえられた・いぬで返された相手
    pub victim: Option<u8>,
    /// 恋モード同士の入れかえで、相手が目をさました
    pub wake: bool,
    pub picked: Option<Item>,
    pub gain: [i32; 3],
    pub eaten: Vec<u8>,
    /// 恋ボーナスがついた
    pub loved: bool,
}

/// 種と番号から 0〜1 の数（rules.js の rnd と同じ）
pub fn rnd(seed: u32, n: u32) -> f64 {
    let mut x = seed ^ (n + 1).wrapping_mul(2654435761);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x as f64 / 4294967296.0
}

/// 手持ちの数の「おまかせ」：4つ並べなら6個
pub fn hand_for(size: usize, need: usize) -> i32 {
    if need >= 4 {
        6
    } else if size >= 6 {
        5
    } else {
        4
    }
}

/// ルールと盤の形（nb：となりのマス、win：並びになりうるマスの組）
pub struct Rules {
    pub cfg: Config,
    pub nb: Vec<Vec<u8>>,
    pub win: Vec<Vec<u8>>,
}

impl Rules {
    pub fn new(cfg: Config) -> Self {
        assert!(cfg.size <= MAX_SIZE && cfg.need <= cfg.size);
        let n = cfg.size as i32;
        let k = cfg.need as i32;
        let mut nb = Vec::new();
        for i in 0..n * n {
            let (r, c) = (i / n, i % n);
            let mut o = Vec::new();
            for (dr, dc) in [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)] {
                let (rr, cc) = (r + dr, c + dc);
                if rr >= 0 && rr < n && cc >= 0 && cc < n {
                    o.push((rr * n + cc) as u8);
                }
            }
            nb.push(o);
        }
        let mut win = Vec::new();
        for r in 0..n {
            for c in 0..n {
                for (dr, dc) in [(0, 1), (1, 0), (1, 1), (1, -1)] {
                    let (er, ec) = (r + dr * (k - 1), c + dc * (k - 1));
                    if er < 0 || er >= n || ec < 0 || ec >= n {
                        continue;
                    }
                    win.push((0..k).map(|s| ((r + dr * s) * n + c + dc * s) as u8).collect());
                }
            }
        }
        Rules { cfg, nb, win }
    }

    pub fn cells(&self) -> usize {
        self.cfg.size * self.cfg.size
    }

    pub fn new_state(&self, hand: i32, start: u8, seed: u32) -> State {
        State {
            cells: [EMPTY; CELLS],
            hands: [hand; 3],
            scores: [0; 3],
            fixed: Vec::new(),
            turn: start,
            moves: 0,
            items: [None; 3],
            bx: None,
            seed,
        }
    }

    pub fn is_love(st: &State, i: u8) -> bool {
        st.fixed.contains(&i)
    }

    fn can_swap(st: &State, i: u8, j: u8, p: u8) -> bool {
        let v = st.cells[j as usize];
        v != EMPTY && v != p && Self::is_love(st, i) == Self::is_love(st, j)
    }

    /// アイテムを使える相手のマス。対象のいらないアイテムは [None]、使えないなら []
    pub fn item_targets(&self, st: &State, k: Item, p: u8) -> Vec<Option<u8>> {
        let m = self.cells() as u8;
        match k {
            Item::Arrow => (0..m).filter(|&i| st.cells[i as usize] == p && !Self::is_love(st, i)).map(Some).collect(),
            Item::Dog => (0..m)
                .filter(|&i| st.cells[i as usize] != EMPTY && st.cells[i as usize] != p)
                .map(Some)
                .collect(),
            Item::Rain => {
                if st.fixed.is_empty() {
                    vec![]
                } else {
                    vec![None]
                }
            }
            Item::Dove => vec![None],
        }
    }

    /// 合法手（rules.js と同じ並び：アイテム → 置く → 自分のお菓子ごとに動かす・入れかえ）
    pub fn actions(&self, st: &State, p: u8) -> Vec<Action> {
        let mut out = Vec::new();
        self.actions_into(st, p, &mut out);
        out
    }

    pub fn actions_into(&self, st: &State, p: u8, out: &mut Vec<Action>) {
        out.clear();
        let m = self.cells();
        if self.cfg.party {
            if let Some(k) = st.items[p as usize] {
                for to in self.item_targets(st, k, p) {
                    out.push(Action::Item { k, to });
                }
            }
        }
        if st.hands[p as usize] > 0 {
            for i in 0..m {
                if st.cells[i] == EMPTY {
                    out.push(Action::Place { to: i as u8 });
                }
            }
        }
        for i in 0..m {
            if st.cells[i] != p {
                continue;
            }
            for &j in &self.nb[i] {
                if st.cells[j as usize] == EMPTY {
                    out.push(Action::Move { from: i as u8, to: j });
                } else if Self::can_swap(st, i as u8, j, p) {
                    out.push(Action::Swap { from: i as u8, to: j });
                }
            }
        }
    }

    fn has_action(&self, st: &State, p: u8) -> bool {
        if self.cfg.party {
            if let Some(k) = st.items[p as usize] {
                if !self.item_targets(st, k, p).is_empty() {
                    return true;
                }
            }
        }
        let m = self.cells();
        if st.hands[p as usize] > 0 && (0..m).any(|i| st.cells[i] == EMPTY) {
            return true;
        }
        (0..m).any(|i| {
            st.cells[i] == p
                && self.nb[i].iter().any(|&j| st.cells[j as usize] == EMPTY || Self::can_swap(st, i as u8, j, p))
        })
    }

    /// 揃った並び（持ち主, win の番号）
    pub fn lines(&self, cells: &[u8; CELLS]) -> Vec<(u8, usize)> {
        let mut out = Vec::new();
        for (wi, w) in self.win.iter().enumerate() {
            let p = cells[w[0] as usize];
            if p != EMPTY && w.iter().all(|&j| cells[j as usize] == p) {
                out.push((p, wi));
            }
        }
        out
    }

    /// 恋ボーナス：恋モードの自分のお菓子を動かした（入れかえ含む）手なら、そのお菓子の行き先
    fn love_to(&self, st: &State, a: &Action) -> Option<u8> {
        if !self.cfg.love_bonus {
            return None;
        }
        match *a {
            Action::Move { from, to } | Action::Swap { from, to } if Self::is_love(st, from) => Some(to),
            _ => None,
        }
    }

    fn use_item(&self, st: &State, k: Item, to: Option<u8>, p: u8, info: &mut StepInfo) -> State {
        let mut s = st.clone();
        s.items[p as usize] = None;
        match k {
            Item::Arrow => s.fixed.push(to.unwrap()),
            Item::Dog => {
                let t = to.unwrap();
                let v = s.cells[t as usize];
                info.victim = Some(v);
                s.cells[t as usize] = EMPTY;
                s.hands[v as usize] += 1;
                s.fixed.retain(|&i| i != t);
            }
            Item::Rain => s.fixed.clear(),
            Item::Dove => s.hands[p as usize] += 1,
        }
        s.moves += 1;
        s
    }

    /// ① 置く・動かす・入れかえ（食べる前）。戻り値の2つめは恋ボーナスの行き先
    fn act(&self, st: &State, a: &Action, p: u8, info: &mut StepInfo) -> (State, Option<u8>) {
        if let Action::Item { k, to } = *a {
            return (self.use_item(st, k, to, p, info), None);
        }
        let mut s = st.clone();
        let to = match *a {
            Action::Place { to } => {
                s.cells[to as usize] = p;
                s.hands[p as usize] -= 1;
                to
            }
            Action::Move { from, to } => {
                s.cells[to as usize] = p;
                s.cells[from as usize] = EMPTY;
                if let Some(k) = s.fixed.iter().position(|&i| i == from) {
                    s.fixed[k] = to;
                }
                to
            }
            Action::Swap { from, to } => {
                let o = st.cells[to as usize];
                s.cells[to as usize] = p;
                s.cells[from as usize] = o;
                info.victim = Some(o);
                if Self::is_love(st, from) && Self::is_love(st, to) {
                    // 恋モード同士：ぶつけられた相手のお菓子が目をさます
                    info.wake = true;
                    s.fixed.retain(|&i| i != from);
                } else {
                    // ふつう同士：ぶつけられた相手のお菓子が一目ぼれ
                    s.fixed.push(from);
                }
                to
            }
            Action::Item { .. } => unreachable!(),
        };
        s.moves += 1;
        if self.cfg.party {
            if let Some((at, k)) = st.bx {
                if at == to {
                    // 箱のマスに来たら拾う（持てるのは1つ。持っていたら入れかわる）
                    s.items[p as usize] = Some(k);
                    s.bx = None;
                    info.picked = Some(k);
                }
            }
        }
        (s, self.love_to(st, a))
    }

    /// ② 揃った並びを食べて点を入れる。食べたお菓子は手持ちに戻る。winners：目標点に届いた人（同時なら打った人）
    fn eat(&self, st: State, mover: u8, lt: Option<u8>, info: &mut StepInfo) -> State {
        let ls = self.lines(&st.cells);
        if ls.is_empty() {
            return st;
        }
        let mut gain = [0i32; 3];
        for &(p, _) in &ls {
            gain[p as usize] += 1;
        }
        let mover_lines = gain[mover as usize];
        if let Some(t) = lt {
            if ls.iter().any(|&(p, wi)| p == mover && self.win[wi].contains(&t)) {
                gain[mover as usize] += 1;
            }
        }
        let mut eaten: Vec<u8> = Vec::new();
        for &(_, wi) in &ls {
            for &j in &self.win[wi] {
                if !eaten.contains(&j) {
                    eaten.push(j);
                }
            }
        }
        let mut s = st;
        for &i in &eaten {
            let v = s.cells[i as usize];
            s.hands[v as usize] += 1;
            s.cells[i as usize] = EMPTY;
        }
        for q in 0..3 {
            s.scores[q] = (s.scores[q] + gain[q]).min(self.cfg.target);
        }
        s.fixed.retain(|i| !eaten.contains(i));
        let w: Vec<u8> = (0..3u8).filter(|&q| s.scores[q as usize] >= self.cfg.target).collect();
        info.winners = if w.len() > 1 && w.contains(&mover) { vec![mover] } else { w };
        info.loved = gain[mover as usize] > mover_lines;
        info.gain = gain;
        info.eaten = eaten;
        s
    }

    fn top(st: &State) -> Vec<u8> {
        let m = *st.scores.iter().max().unwrap();
        (0..3u8).filter(|&q| st.scores[q as usize] == m).collect()
    }

    /// ③ 次の番へ。動けない人はパス。時間切れ・誰も動けないときは、その時点で点が多い人の勝ち
    fn next(&self, st: State, info: &mut StepInfo) -> State {
        if st.moves >= self.cfg.max_moves {
            info.end = Some(EndReason::Timeout);
            info.winners = Self::top(&st);
            return st;
        }
        let mut turn = st.turn;
        for _ in 0..3 {
            turn = (turn + 1) % 3;
            if self.has_action(&st, turn) {
                break;
            }
            info.skipped.push(turn);
        }
        if info.skipped.len() >= 3 {
            info.end = Some(EndReason::Stuck);
            info.winners = Self::top(&st);
            return st;
        }
        let mut ns = st;
        ns.turn = turn;
        if self.cfg.party && ns.bx.is_none() && ns.moves > 0 && ns.moves % SPAWN == 0 {
            // アイテム箱が落ちてくる
            let e: Vec<u8> = (0..self.cells() as u8).filter(|&i| ns.cells[i as usize] == EMPTY).collect();
            if !e.is_empty() {
                let seed = if ns.seed == 0 { 1 } else { ns.seed };
                let at = e[(rnd(seed, ns.moves * 2) * e.len() as f64) as usize];
                let k = ITEMS[(rnd(seed, ns.moves * 2 + 1) * 4.0) as usize];
                ns.bx = Some((at, k));
            }
        }
        ns
    }

    /// ①②だけ（番は進めない）。CPU の読み用（cpu.js の applyOn）。3つめは食べる前の盤
    pub fn act_eat(&self, st: &State, a: &Action, p: u8) -> (State, StepInfo, [u8; CELLS]) {
        let mut info = StepInfo::default();
        let (s, lt) = self.act(st, a, p, &mut info);
        let before = s.cells;
        if let Action::Item { .. } = a {
            return (s, info, before);
        }
        let s = self.eat(s, p, lt, &mut info);
        (s, info, before)
    }

    /// ①②③をまとめて1手。アイテムでは番は進まない
    pub fn step(&self, st: &State, a: &Action) -> (State, StepInfo) {
        let mut info = StepInfo::default();
        let p = st.turn;
        let (s, lt) = self.act(st, a, p, &mut info);
        if let Action::Item { .. } = a {
            return (s, info);
        }
        let s = self.eat(s, p, lt, &mut info);
        if !info.winners.is_empty() {
            info.end = Some(EndReason::Win);
            return (s, info);
        }
        let s = self.next(s, &mut info);
        (s, info)
    }
}
