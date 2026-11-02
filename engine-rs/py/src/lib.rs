//! Pythonから使う自己対局ドライバ（三人将棋の engine-rs/py と同じ形。計画は docs/ai-plan.md）。
//!
//! 数百セットを同時に進め、ネットの評価が必要な葉をまとめて Python に渡す（`next_batch`）。
//! Python は PyTorch で推論して結果を返す（`submit`）。終わったセットから学習データを作る（`take_finished`）。
//!
//! 局面は STATE_BYTES（196）バイトの形でやり取りする（SetRules::encode。入力チャンネルへの展開は Python 側）。
//! ルール（盤の大きさ・並べる数・手持ち・目標点・恋ボーナス・わいわい・局数・勝ちボーナス・席ごとの a）はセットごとにくじ引きし、
//! 1つのネットで全部を学ぶ。
//! 価値は Python が返す「3人それぞれの順位点の見込み」（ネットの順位の予想と a から計算する）。

use okashi_core::*;
use okashi_mcts::{settle, Agent, CpuAgent, EvalOut, Leaf, Level, MctsAgent, RandomAgent, Rng, RolloutEval, Search, SearchConfig};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};
use std::sync::Arc;

fn read_f32(b: &[u8], i: usize) -> f32 {
    f32::from_le_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]])
}

fn le<T: Copy, const N: usize>(v: &[T], f: impl Fn(T) -> [u8; N]) -> Vec<u8> {
    v.iter().flat_map(|&x| f(x)).collect()
}

// ── 席ごとのプレイヤー ──

enum Seat {
    /// ネット（番号でモデルを区別）。2つ目は全力探索の訪問数（0なら visits_full）
    Net(u8, u32),
    /// ネット以外（ランダム評価のMCTS・ランダム）。Rust内で即座に指す
    Internal(Box<dyn Agent>),
}

fn make_seat(spec: &str, seed: u64) -> PyResult<Seat> {
    let parts: Vec<&str> = spec.split(':').collect();
    let num = |i: usize, d: u32| parts.get(i).and_then(|s| s.parse::<u32>().ok()).unwrap_or(d);
    Ok(match parts[0] {
        "net" => Seat::Net(num(1, 0) as u8, num(2, 0)),
        "mcts" => Seat::Internal(Box::new(MctsAgent {
            eval: RolloutEval { rng: Rng::new(seed), rollouts: 1 },
            visits: num(1, 200),
            cfg: SearchConfig::default(),
        })),
        "random" => Seat::Internal(Box::new(RandomAgent::new(seed))),
        // 今の CPU（cpu.js を写したもの）："cpu:easy" / "cpu:normal" / "cpu:hard"
        "cpu" => Seat::Internal(Box::new(CpuAgent {
            level: match parts.get(1).copied().unwrap_or("hard") {
                "easy" => Level::Easy,
                "normal" => Level::Normal,
                "hard" => Level::Hard,
                x => return Err(PyValueError::new_err(format!("cpu の強さは easy/normal/hard（{x}）"))),
            },
            rng: Rng::new(seed),
        })),
        _ => return Err(PyValueError::new_err(format!("未知の席の種類 {spec}"))),
    })
}

// ── ルールのくじ引き ──

#[derive(Clone)]
struct RuleDist {
    sizes: Vec<usize>,
    /// 7×7 以上で5つ並べにする割合
    need5_prob: f64,
    hand: (i32, i32),
    target: (i32, i32),
    love_prob: f64,
    party_prob: f64,
    games: Vec<u8>,
    bonus: Vec<i32>,
    /// 席ごとの a をこの中から選ぶ
    a_values: Vec<f32>,
}

impl RuleDist {
    fn draw(&self, r: &mut Rng) -> SetRules {
        let size = self.sizes[r.below(self.sizes.len())];
        let need = if size >= 7 && r.unit() < self.need5_prob { 5 } else { 4 };
        let range = |r: &mut Rng, (lo, hi): (i32, i32)| lo + r.below((hi - lo + 1).max(1) as usize) as i32;
        let hand = range(r, self.hand);
        let target = range(r, self.target);
        let cfg = Config { size, need, target, love_bonus: r.unit() < self.love_prob, max_moves: MAX_MOVES, party: r.unit() < self.party_prob };
        let a = [0, 1, 2].map(|_| self.a_values[r.below(self.a_values.len())]);
        let set = SetConfig {
            hand,
            games: self.games[r.below(self.games.len())],
            win_bonus: self.bonus[r.below(self.bonus.len())],
            first: r.below(3) as u8,
            a,
        };
        SetRules::new(cfg, set)
    }
}

// ── 進行中のセット ──

struct PlyRecord {
    state: Vec<u8>,
    /// 全力探索のときだけ（合法手の方策番号と訪問数）
    policy: Option<(Vec<i32>, Vec<u32>)>,
    root_value: [f32; 3],
    game_idx: u8,
}

struct Pending {
    leaf: Leaf,
    actions: Vec<Action>,
    is_root: bool,
}

struct SetGame {
    id: u64,
    sr: Arc<SetRules>,
    s: SetState,
    seats: Vec<Seat>,
    search: Option<Search>,
    target: u32,
    full: bool,
    pending: Option<Pending>,
    records: Vec<PlyRecord>,
    record: bool,
    /// 局ごとの最後の点（局の番号順）
    game_scores: Vec<[i32; 3]>,
    plies: u32,
    rng: Rng,
}

#[derive(Clone)]
struct Cfg {
    visits_full: u32,
    visits_fast: u32,
    full_prob: f64,
    temp_plies: u32,
    search: SearchConfig,
}

#[pyclass(unsendable)]
pub struct Driver {
    games: Vec<SetGame>,
    cfg: Cfg,
    dist: RuleDist,
    seat_specs: Vec<String>,
    rotate: bool,
    record: bool,
    total: u64,
    started: u64,
    seed: u64,
    finished: Vec<SetGame>,
    batch_order: Vec<usize>,
}

impl Driver {
    fn new_game(&mut self) -> PyResult<SetGame> {
        let id = self.started;
        self.started += 1;
        let seed = self.seed.wrapping_mul(1_000_003).wrapping_add(id);
        let mut pick = Rng::new(seed ^ 0x5EED_A17);
        let sr = Arc::new(self.dist.draw(&mut pick));
        let rot = if self.rotate { (id % 3) as usize } else { 0 };
        let mut seats = Vec::with_capacity(3);
        for s in 0..3 {
            seats.push(make_seat(&self.seat_specs[(s + 3 - rot) % 3], seed * 3 + s as u64)?);
        }
        let s = settle(&sr, sr.initial(pick.next_u64() as u32));
        Ok(SetGame {
            id,
            sr,
            s,
            seats,
            search: None,
            target: 0,
            full: false,
            pending: None,
            records: Vec::new(),
            record: self.record,
            game_scores: Vec::new(),
            plies: 0,
            rng: Rng::new(seed ^ 0xABCDEF),
        })
    }

    /// 1セットを、ネットの評価が必要になるか終わるまで進める。評価待ちなら true
    fn advance(g: &mut SetGame, cfg: &Cfg) -> bool {
        loop {
            if g.s.over {
                return false;
            }
            let turn = g.s.game.turn as usize;
            if let Seat::Internal(agent) = &mut g.seats[turn] {
                let act = agent.choose(&g.sr, &g.s).expect("settle 済みなら合法手がある");
                Self::play(g, act);
                continue;
            }
            if g.search.is_none() {
                g.full = cfg.full_prob >= 1.0 || g.rng.unit() < cfg.full_prob;
                g.target = if g.full { cfg.visits_full } else { cfg.visits_fast };
                if let Seat::Net(_, v) = g.seats[turn] {
                    if g.full && v > 0 {
                        g.target = v;
                    }
                }
                let mut sc = cfg.search.clone();
                if !g.full {
                    sc.dirichlet_total = 0.0;
                }
                g.search = Some(Search::new(g.sr.clone(), g.s.clone(), sc));
            }
            let s = g.search.as_mut().unwrap();
            if s.root_visits() >= g.target {
                Self::finish_move(g, cfg);
                continue;
            }
            let leaf = s.select();
            if leaf.terminal.is_some() {
                s.expand(leaf, &[], None);
                continue;
            }
            let is_root = s.root_visits() == 0;
            let actions = s.leaf_actions(&leaf);
            g.pending = Some(Pending { leaf, actions, is_root });
            return true;
        }
    }

    /// 探索が終わった局面で手を決めて指す（自己対局なら記録を残す）
    fn finish_move(g: &mut SetGame, cfg: &Cfg) {
        let s = g.search.take().unwrap();
        let act = if g.s.game.moves < cfg.temp_plies { s.sample_action(1.0, &mut g.rng) } else { s.best_action() };
        // 学習データは現世代（ネット0番）の手番だけ残す
        let mine = matches!(g.seats[g.s.game.turn as usize], Seat::Net(0, _));
        if g.record && mine {
            let mut state = Vec::with_capacity(STATE_BYTES);
            g.sr.encode(&g.s, &mut state);
            let policy = g.full.then(|| {
                let vc = s.root_visit_counts();
                (vc.iter().map(|x| g.sr.policy_index(&x.0) as i32).collect(), vc.iter().map(|x| x.1).collect())
            });
            g.records.push(PlyRecord { state, policy, root_value: s.root_value(), game_idx: g.s.game_idx });
        }
        Self::play(g, act);
    }

    fn play(g: &mut SetGame, act: Action) {
        let (ns, _) = g.sr.step(&g.s, &act);
        g.plies += 1;
        g.s = settle(&g.sr, ns);
        // 局が終わったら、その局の最後の点を残す（settle で続けて終わった局も同じ点で埋める。めったにない）
        while g.game_scores.len() < SetRules::games_done(&g.s) {
            g.game_scores.push(g.s.last_scores);
        }
    }
}

#[pymethods]
impl Driver {
    /// seats: 3つの席の種類（"net:0" / "net:1" / "net:0:訪問数" / "cpu:easy|normal|hard"（今のCPU）/ "mcts:訪問数"（ランダム評価）/ "random"）。rotate=True でセットごとに席をずらす
    #[new]
    #[pyo3(signature = (parallel, total_sets, seats, rotate=false, record=true, visits_full=400, visits_fast=80, full_prob=0.25,
                        temp_plies=8, c_puct=1.5, fpu_reduction=0.2, dirichlet_total=10.0, dirichlet_weight=0.25, seed=1,
                        sizes=vec![5, 6, 7, 8, 9], need5_prob=0.3, hand=(4, 10), target=(2, 4), love_prob=0.8, party_prob=0.0,
                        games=vec![1, 3], bonus=vec![0, 1, 2, 3], a_values=vec![0.0]))]
    #[allow(clippy::too_many_arguments)]
    fn py_new(
        parallel: usize,
        total_sets: u64,
        seats: Vec<String>,
        rotate: bool,
        record: bool,
        visits_full: u32,
        visits_fast: u32,
        full_prob: f64,
        temp_plies: u32,
        c_puct: f32,
        fpu_reduction: f32,
        dirichlet_total: f32,
        dirichlet_weight: f32,
        seed: u64,
        sizes: Vec<usize>,
        need5_prob: f64,
        hand: (i32, i32),
        target: (i32, i32),
        love_prob: f64,
        party_prob: f64,
        games: Vec<u8>,
        bonus: Vec<i32>,
        a_values: Vec<f32>,
    ) -> PyResult<Driver> {
        if seats.len() != 3 {
            return Err(PyValueError::new_err("seats は3つ"));
        }
        if sizes.iter().any(|&s| !(4..=MAX_SIZE).contains(&s)) || sizes.is_empty() || games.is_empty() || bonus.is_empty() || a_values.is_empty() {
            return Err(PyValueError::new_err("sizes は4〜9、games・bonus・a_values は空にしない"));
        }
        let mut d = Driver {
            games: Vec::new(),
            cfg: Cfg {
                visits_full,
                visits_fast,
                full_prob,
                temp_plies,
                search: SearchConfig { c_puct, fpu_reduction, dirichlet_total, dirichlet_weight },
            },
            dist: RuleDist { sizes, need5_prob, hand, target, love_prob, party_prob, games, bonus, a_values },
            seat_specs: seats,
            rotate,
            record,
            total: total_sets,
            started: 0,
            seed,
            finished: Vec::new(),
            batch_order: Vec::new(),
        };
        for _ in 0..parallel.min(total_sets as usize) {
            let g = d.new_game()?;
            d.games.push(g);
        }
        Ok(d)
    }

    /// 評価待ちの局面をまとめて返す。全セット終わっていれば None。
    /// 戻り値: (states: bytes[B*STATE_BYTES], legal: bytes[i32 B*L], L, model: bytes[u8 B])  legal は -1 で埋める
    fn next_batch<'py>(&mut self, py: Python<'py>) -> PyResult<Option<(Bound<'py, PyBytes>, Bound<'py, PyBytes>, usize, Bound<'py, PyBytes>)>> {
        self.batch_order.clear();
        let mut i = 0;
        while i < self.games.len() {
            let has = self.games[i].pending.is_some() || Self::advance(&mut self.games[i], &self.cfg);
            if self.games[i].s.over {
                let g = self.games.swap_remove(i);
                self.finished.push(g);
                if self.started < self.total {
                    let ng = self.new_game()?;
                    self.games.push(ng);
                }
                continue;
            }
            if has {
                self.batch_order.push(i);
            }
            i += 1;
        }
        if self.batch_order.is_empty() {
            return Ok(None);
        }
        let l = self.batch_order.iter().map(|&i| self.games[i].pending.as_ref().unwrap().actions.len()).max().unwrap();
        let mut states = Vec::with_capacity(self.batch_order.len() * STATE_BYTES);
        let mut legal: Vec<i32> = Vec::with_capacity(self.batch_order.len() * l);
        let mut model = Vec::with_capacity(self.batch_order.len());
        for &i in &self.batch_order {
            let g = &self.games[i];
            let p = g.pending.as_ref().unwrap();
            let s = g.search.as_ref().unwrap().leaf_state(&p.leaf);
            g.sr.encode(s, &mut states);
            for k in 0..l {
                legal.push(p.actions.get(k).map_or(-1, |a| g.sr.policy_index(a) as i32));
            }
            model.push(match &g.seats[g.s.game.turn as usize] {
                Seat::Net(n, _) => *n,
                _ => 0,
            });
        }
        Ok(Some((PyBytes::new_bound(py, &states), PyBytes::new_bound(py, &le(&legal, i32::to_le_bytes)), l, PyBytes::new_bound(py, &model))))
    }

    /// next_batch の順に評価を返す。priors: f32[B*L]（L は next_batch と同じ）、values: f32[B*3]（各席の順位点の見込み）
    fn submit(&mut self, priors: &[u8], values: &[u8], l: usize) -> PyResult<()> {
        let b = self.batch_order.len();
        if priors.len() != b * l * 4 || values.len() != b * 12 {
            return Err(PyValueError::new_err("submit の大きさが next_batch と合わない"));
        }
        for (bi, &gi) in self.batch_order.iter().enumerate() {
            let g = &mut self.games[gi];
            let p = g.pending.take().unwrap();
            let n = p.actions.len();
            let pr: Vec<f32> = (0..n).map(|k| read_f32(priors, bi * l + k)).collect();
            let value = [read_f32(values, bi * 3), read_f32(values, bi * 3 + 1), read_f32(values, bi * 3 + 2)];
            let s = g.search.as_mut().unwrap();
            s.expand(p.leaf, &p.actions, Some(EvalOut { priors: pr, value }));
            if p.is_root {
                s.add_root_noise(&mut g.rng);
            }
        }
        self.batch_order.clear();
        Ok(())
    }

    fn done(&self) -> bool {
        self.games.is_empty()
    }

    fn finished_count(&self) -> usize {
        self.finished.len()
    }

    /// 終わったセットを取り出す。学習データ（1局面1行）とセットの要約を bytes の dict で返す
    ///   states [N,196] / policy_offsets [N+1] i64 / policy_index i32 / policy_visits u32 / full [N]
    ///   rank [N,3,3] f32（各席の最終順位の割合。同点は分け合う）/ root_value [N,3] / game_score [N,3] u8（その局の最後の点）/ set_id [N] u32
    ///   g_id u32 / g_totals [G,3] i32（UNIT 倍）/ g_utility [G,3] f32 / g_seat_net [G,3] i8 / g_plies u32
    ///   g_cfg [G,12] u8（盤・並べる数・手持ち・目標点・恋ボーナス・わいわい・局数・勝ちボーナス・1局目の先手・a×100 ×3）
    fn take_finished<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let games = std::mem::take(&mut self.finished);
        let d = PyDict::new_bound(py);
        let mut states = Vec::new();
        let mut pol_off: Vec<i64> = vec![0];
        let (mut pol_idx, mut pol_cnt): (Vec<i32>, Vec<u32>) = (Vec::new(), Vec::new());
        let (mut full, mut rank, mut root_v, mut game_score, mut set_id) = (Vec::new(), Vec::<f32>::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut g_id, mut g_totals, mut g_util, mut g_seat, mut g_plies, mut g_cfg) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for g in &games {
            let rs = SetRules::rank_share(&g.s.totals);
            for r in &g.records {
                states.extend_from_slice(&r.state);
                match &r.policy {
                    Some((idx, cnt)) => {
                        pol_idx.extend_from_slice(idx);
                        pol_cnt.extend_from_slice(cnt);
                        full.push(1u8);
                    }
                    None => full.push(0u8),
                }
                pol_off.push(pol_idx.len() as i64);
                for q in 0..3 {
                    rank.extend_from_slice(&rs[q]);
                }
                root_v.extend_from_slice(&r.root_value);
                let gs = g.game_scores.get(r.game_idx as usize).copied().unwrap_or([0; 3]);
                game_score.extend(gs.iter().map(|&x| x.clamp(0, 255) as u8));
                set_id.push(g.id as u32);
            }
            g_id.push(g.id as u32);
            g_totals.extend_from_slice(&g.s.totals);
            g_util.extend_from_slice(&g.sr.utility(&g.s.totals));
            for s in &g.seats {
                g_seat.push(match s {
                    Seat::Net(n, _) => *n as u8,
                    Seat::Internal(_) => 255,
                });
            }
            g_plies.push(g.plies);
            let (c, st) = (&g.sr.rules.cfg, &g.sr.set);
            g_cfg.extend_from_slice(&[c.size as u8, c.need as u8, st.hand as u8, c.target as u8, c.love_bonus as u8, c.party as u8, st.games, st.win_bonus as u8, st.first]);
            g_cfg.extend(st.a.iter().map(|&a| (a * 100.0).round() as u8));
        }
        d.set_item("states", PyBytes::new_bound(py, &states))?;
        d.set_item("policy_offsets", PyBytes::new_bound(py, &le(&pol_off, i64::to_le_bytes)))?;
        d.set_item("policy_index", PyBytes::new_bound(py, &le(&pol_idx, i32::to_le_bytes)))?;
        d.set_item("policy_visits", PyBytes::new_bound(py, &le(&pol_cnt, u32::to_le_bytes)))?;
        d.set_item("full", PyBytes::new_bound(py, &full))?;
        d.set_item("rank", PyBytes::new_bound(py, &le(&rank, f32::to_le_bytes)))?;
        d.set_item("root_value", PyBytes::new_bound(py, &le(&root_v, f32::to_le_bytes)))?;
        d.set_item("game_score", PyBytes::new_bound(py, &game_score))?;
        d.set_item("set_id", PyBytes::new_bound(py, &le(&set_id, u32::to_le_bytes)))?;
        d.set_item("g_id", PyBytes::new_bound(py, &le(&g_id, u32::to_le_bytes)))?;
        d.set_item("g_totals", PyBytes::new_bound(py, &le(&g_totals, i32::to_le_bytes)))?;
        d.set_item("g_utility", PyBytes::new_bound(py, &le(&g_util, f32::to_le_bytes)))?;
        d.set_item("g_seat_net", PyBytes::new_bound(py, &g_seat))?;
        d.set_item("g_plies", PyBytes::new_bound(py, &le(&g_plies, u32::to_le_bytes)))?;
        d.set_item("g_cfg", PyBytes::new_bound(py, &g_cfg))?;
        Ok(d)
    }
}

#[pymodule]
fn okashi_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Driver>()?;
    m.add("STATE_BYTES", STATE_BYTES)?;
    m.add("NUM_POLICY", NUM_POLICY)?;
    Ok(())
}
