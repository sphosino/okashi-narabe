//! 3人用 PUCT 探索（三人将棋の search.rs と同じ形）。

use crate::eval::{EvalOut, Evaluator};
use crate::rng::Rng;
use okashi_core::{Action, SetRules, SetState};
use std::sync::Arc;

const NONE: u32 = u32::MAX;

/// 合法手がないまま止まった局（アイテムを使ったあと何もできない、など）を、その時点の点で終えて次へ進める
pub fn settle(sr: &SetRules, mut s: SetState) -> SetState {
    while !s.over && sr.actions(&s).is_empty() {
        s = sr.end_stuck(&s);
    }
    s
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub c_puct: f32,
    /// 未訪問の子の Q = 親の Q − この値（First Play Urgency）
    pub fpu_reduction: f32,
    /// 根のディリクレノイズ（0 なら入れない）。α = dirichlet_total / 合法手数
    pub dirichlet_total: f32,
    pub dirichlet_weight: f32,
}

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig { c_puct: 1.5, fpu_reduction: 0.2, dirichlet_total: 0.0, dirichlet_weight: 0.25 }
    }
}

struct Edge {
    act: Action,
    prior: f32,
    child: u32,
}

struct Node {
    s: SetState,
    edges_start: u32,
    edges_len: u32,
    expanded: bool,
    /// セットが終わったノードなら各席の順位点
    terminal: Option<[f32; 3]>,
    n: u32,
    w: [f32; 3],
    /// 仮想訪問（評価待ちの葉までの道に足す。まとめて評価するとき、同じ道ばかり選ばないように）
    vl: u32,
}

/// 評価待ちの葉（またはすでに値が決まっている終局ノード）
pub struct Leaf {
    path: Vec<u32>,
    pub terminal: Option<[f32; 3]>,
}

impl Leaf {
    fn node(&self) -> u32 {
        *self.path.last().unwrap()
    }
    pub fn id(&self) -> u32 {
        self.node()
    }
}

pub struct Search {
    pub sr: Arc<SetRules>,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    cfg: SearchConfig,
}

impl Search {
    pub fn new(sr: Arc<SetRules>, root: SetState, cfg: SearchConfig) -> Search {
        let root = settle(&sr, root);
        let terminal = root.over.then(|| sr.utility(&root.totals));
        Search {
            sr,
            nodes: vec![Node { s: root, edges_start: 0, edges_len: 0, expanded: false, terminal, n: 0, w: [0.0; 3], vl: 0 }],
            edges: Vec::new(),
            cfg,
        }
    }

    pub fn root(&self) -> &SetState {
        &self.nodes[0].s
    }

    pub fn root_visits(&self) -> u32 {
        self.nodes[0].n
    }

    /// 根から PUCT で降りて、評価が必要な葉（または終局ノード）を返す
    pub fn select(&mut self) -> Leaf {
        let mut path = vec![0u32];
        let mut cur = 0u32;
        loop {
            let node = &self.nodes[cur as usize];
            if let Some(t) = node.terminal {
                return Leaf { path, terminal: Some(t) };
            }
            if !node.expanded {
                return Leaf { path, terminal: None };
            }
            let p = node.s.game.turn as usize;
            let sqrt_n = ((node.n + node.vl).max(1) as f32).sqrt();
            let parent_q = if node.n > 0 { node.w[p] / node.n as f32 } else { 0.0 };
            let fpu = (parent_q - self.cfg.fpu_reduction).max(0.0);
            let (s, l) = (node.edges_start as usize, node.edges_len as usize);
            let mut best = s;
            let mut best_score = f32::MIN;
            for i in s..s + l {
                let e = &self.edges[i];
                let (q, cn) = if e.child == NONE {
                    (fpu, 0u32)
                } else {
                    let c = &self.nodes[e.child as usize];
                    let vn = c.n + c.vl;
                    if vn == 0 {
                        (fpu, 0)
                    } else {
                        // 仮想訪問は「価値0」として数える
                        (c.w[p] / vn as f32, vn)
                    }
                };
                let score = q + self.cfg.c_puct * e.prior * sqrt_n / (1.0 + cn as f32);
                if score > best_score {
                    best_score = score;
                    best = i;
                }
            }
            if self.edges[best].child == NONE {
                let act = self.edges[best].act;
                let ns = settle(&self.sr, self.sr.step(&self.nodes[cur as usize].s, &act).0);
                let terminal = ns.over.then(|| self.sr.utility(&ns.totals));
                let id = self.nodes.len() as u32;
                self.nodes.push(Node { s: ns, edges_start: 0, edges_len: 0, expanded: false, terminal, n: 0, w: [0.0; 3], vl: 0 });
                self.edges[best].child = id;
                path.push(id);
                return Leaf { path, terminal };
            }
            cur = self.edges[best].child;
            path.push(cur);
        }
    }

    /// 葉の局面（評価器に渡す）
    pub fn leaf_state(&self, leaf: &Leaf) -> &SetState {
        &self.nodes[leaf.node() as usize].s
    }

    /// 葉の合法手
    pub fn leaf_actions(&self, leaf: &Leaf) -> Vec<Action> {
        self.sr.actions(&self.nodes[leaf.node() as usize].s)
    }

    /// 葉に評価を反映して展開し、値を根まで足し込む。終局ノードなら eval は None でよい
    pub fn expand(&mut self, leaf: Leaf, actions: &[Action], eval: Option<EvalOut>) {
        let value = match leaf.terminal {
            Some(t) => t,
            None => {
                let ev = eval.expect("終局でない葉には評価が必要");
                let id = leaf.node() as usize;
                let start = self.edges.len() as u32;
                for (i, &act) in actions.iter().enumerate() {
                    let prior = if actions.len() == 1 { 1.0 } else { ev.priors.get(i).copied().unwrap_or(0.0) };
                    self.edges.push(Edge { act, prior, child: NONE });
                }
                let node = &mut self.nodes[id];
                node.edges_start = start;
                node.edges_len = actions.len() as u32;
                node.expanded = true;
                ev.value
            }
        };
        for &id in &leaf.path {
            let n = &mut self.nodes[id as usize];
            n.n += 1;
            for k in 0..3 {
                n.w[k] += value[k];
            }
        }
    }

    /// 葉までの道に仮想訪問を1つ足す（評価待ちにするとき）
    pub fn add_virtual(&mut self, leaf: &Leaf) {
        for &id in &leaf.path {
            self.nodes[id as usize].vl += 1;
        }
    }

    /// 仮想訪問を外してから展開する
    pub fn expand_virtual(&mut self, leaf: Leaf, actions: &[Action], eval: Option<EvalOut>) {
        for &id in &leaf.path {
            let n = &mut self.nodes[id as usize];
            n.vl = n.vl.saturating_sub(1);
        }
        self.expand(leaf, actions, eval);
    }

    /// 評価器を直接呼んで visits 回まで探索する（推論をまとめない単純版）
    pub fn run<E: Evaluator>(&mut self, eval: &mut E, visits: u32, mut rng: Option<&mut Rng>) {
        while self.nodes[0].n < visits {
            let leaf = self.select();
            if leaf.terminal.is_some() {
                self.expand(leaf, &[], None);
                continue;
            }
            let is_root = self.nodes[0].n == 0;
            let acts = self.leaf_actions(&leaf);
            let ev = eval.evaluate(&self.sr, self.leaf_state(&leaf), &acts);
            self.expand(leaf, &acts, Some(ev));
            if is_root {
                if let Some(r) = rng.as_deref_mut() {
                    self.add_root_noise(r);
                }
            }
        }
    }

    /// 根の事前確率にディリクレノイズを混ぜる
    pub fn add_root_noise(&mut self, rng: &mut Rng) {
        if self.cfg.dirichlet_total <= 0.0 || !self.nodes[0].expanded {
            return;
        }
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        if l <= 1 {
            return;
        }
        let alpha = (self.cfg.dirichlet_total / l as f32) as f64;
        let g: Vec<f64> = (0..l).map(|_| rng.gamma(alpha)).collect();
        let sum: f64 = g.iter().sum::<f64>().max(1e-12);
        let w = self.cfg.dirichlet_weight;
        for (i, gi) in g.iter().enumerate() {
            let e = &mut self.edges[s + i];
            e.prior = (1.0 - w) * e.prior + w * (*gi / sum) as f32;
        }
    }

    /// 根の各手の訪問数
    pub fn root_visit_counts(&self) -> Vec<(Action, u32)> {
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        (s..s + l)
            .map(|i| {
                let e = &self.edges[i];
                (e.act, if e.child == NONE { 0 } else { self.nodes[e.child as usize].n })
            })
            .collect()
    }

    /// 根の価値（3つ組の平均）
    pub fn root_value(&self) -> [f32; 3] {
        let n = &self.nodes[0];
        let d = n.n.max(1) as f32;
        [n.w[0] / d, n.w[1] / d, n.w[2] / d]
    }

    /// 最多訪問の手（同数なら事前確率が大きい方）
    pub fn best_action(&self) -> Action {
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        let mut best = s;
        let mut key = (0u32, f32::MIN);
        for i in s..s + l {
            let e = &self.edges[i];
            let n = if e.child == NONE { 0 } else { self.nodes[e.child as usize].n };
            if n > key.0 || (n == key.0 && e.prior > key.1) {
                key = (n, e.prior);
                best = i;
            }
        }
        self.edges[best].act
    }

    /// 訪問数^(1/温度) に比例して選ぶ（自己対局の序盤用）
    pub fn sample_action(&self, temperature: f32, rng: &mut Rng) -> Action {
        let counts = self.root_visit_counts();
        let weights: Vec<f64> = counts.iter().map(|&(_, n)| (n as f64).powf(1.0 / temperature as f64)).collect();
        let sum: f64 = weights.iter().sum();
        if sum <= 0.0 {
            return self.best_action();
        }
        let mut x = rng.unit() * sum;
        for (i, w) in weights.iter().enumerate() {
            x -= w;
            if x <= 0.0 {
                return counts[i].0;
            }
        }
        counts.last().unwrap().0
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}
