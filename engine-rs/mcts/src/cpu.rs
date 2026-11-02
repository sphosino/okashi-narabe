//! 今の CPU（cpu.js）をそのまま写したもの（tests/cpu_fixtures.rs で照合）。評価対局の物差しと、つまみ付きの相手の土台にする。
//!   やさしい：目の前だけ見る / ふつう：1手先を全部試す / つよい：2手読み（よさそうな手を10個にしぼり、次の人の一番いい返しを当てる）
//! cpu.js の Math.random の揺らぎは rng で入れる（noise=false なら入れない。照合用）。

use crate::agents::Agent;
use crate::rng::Rng;
use okashi_core::*;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Easy,
    Normal,
    Hard,
}

pub struct Cpu<'a> {
    pub r: &'a Rules,
    pub rng: Option<&'a mut Rng>,
}

/// 置く・動かす・入れかえ（アイテムは item_plan で別に考える）
pub fn moves(r: &Rules, st: &State, p: u8) -> Vec<Action> {
    let mut v = r.actions(st, p);
    v.retain(|a| !matches!(a, Action::Item { .. }));
    v
}

/// q が次の一手で揃えられる並びの数
pub fn threats(r: &Rules, c: &[u8; CELLS], q: u8, hands: &[i32; 3], fixed: &[u8]) -> i32 {
    let k = r.cfg.need;
    let love = |i: u8| fixed.contains(&i);
    let mut t = 0;
    for w in &r.win {
        let (mut own, mut empty, mut ne, mut g) = (0, -1i32, 0, -1i32);
        for &j in w {
            if c[j as usize] == q {
                own += 1;
            } else if c[j as usize] == EMPTY {
                ne += 1;
                empty = j as i32;
            } else {
                g = j as i32;
            }
        }
        if own != k - 1 {
            continue;
        }
        let at = if ne == 1 { empty } else { g } as usize;
        let by = |ok: &dyn Fn(u8) -> bool| r.nb[at].iter().filter(|&&j| c[j as usize] == q && !w.contains(&j) && ok(j)).count();
        if ne == 1 {
            if r.cfg.love_bonus && by(&|j| love(j)) > 0 {
                t += 2;
            } else if hands[q as usize] > 0 || by(&|_| true) > 0 {
                t += 1;
            }
        } else if by(&|j| love(j) == love(g as u8)) > 0 {
            t += if r.cfg.love_bonus && love(g as u8) { 2 } else { 1 };
        }
    }
    t
}

/// 揃いかけ（あと2つ）の並びの数
pub fn buildup(r: &Rules, c: &[u8; CELLS], q: u8) -> i32 {
    let k = r.cfg.need;
    if k < 4 {
        return 0;
    }
    let mut t = 0;
    for w in &r.win {
        let (mut own, mut ne) = (0, 0);
        for &j in w {
            if c[j as usize] == q {
                own += 1;
            } else if c[j as usize] == EMPTY {
                ne += 1;
            }
        }
        if own == k - 2 && ne == 2 {
            t += 1;
        }
    }
    t
}

fn open_spots(r: &Rules, c: &[u8; CELLS], q: u8) -> Vec<u8> {
    let k = r.cfg.need;
    let mut s: Vec<u8> = Vec::new();
    for w in &r.win {
        let (mut own, mut e, mut ne) = (0, 0u8, 0);
        for &j in w {
            if c[j as usize] == q {
                own += 1;
            } else if c[j as usize] == EMPTY {
                ne += 1;
                e = j;
            }
        }
        if own == k - 1 && ne == 1 && !s.contains(&e) {
            s.push(e);
        }
    }
    s
}

fn target_of(a: &Action) -> u8 {
    match *a {
        Action::Place { to } | Action::Move { to, .. } | Action::Swap { to, .. } => to,
        Action::Item { to, .. } => to.unwrap_or(0),
    }
}

impl<'a> Cpu<'a> {
    fn noise(&mut self, scale: f64) -> f64 {
        self.rng.as_deref_mut().map_or(0.0, |r| r.unit() * scale)
    }

    /// わいわい：持っているアイテムの使いどき。使うならその手
    pub fn item_plan(&self, st: &State, p: u8) -> Option<Action> {
        let r = self.r;
        let k = st.items[p as usize]?;
        let t = r.item_targets(st, k, p);
        if t.is_empty() {
            return None;
        }
        let n = r.cells();
        match k {
            Item::Dove => (st.hands[p as usize] <= 2).then_some(Action::Item { k, to: None }),
            Item::Rain => (st.fixed.iter().filter(|&&i| st.cells[i as usize] != p).count() >= 2).then_some(Action::Item { k, to: None }),
            Item::Dog => {
                for w in &r.win {
                    let vs: Vec<u8> = w.iter().map(|&i| st.cells[i as usize]).collect();
                    let Some(&q) = vs.iter().find(|&&v| v != EMPTY && v != p) else { continue };
                    if vs.iter().filter(|&&v| v == q).count() == r.cfg.need - 1 && vs.iter().filter(|&&v| v == EMPTY).count() == 1 {
                        return Some(Action::Item { k, to: w.iter().find(|&&i| st.cells[i as usize] == q).copied() });
                    }
                }
                None
            }
            Item::Arrow => {
                if (0..n).filter(|&i| st.cells[i] == p).count() < 2 {
                    return None;
                }
                let (mut best, mut bv) = (None, -1i32);
                for &i in &t {
                    let i = i.unwrap();
                    let v = r.nb[i as usize].iter().filter(|&&j| st.cells[j as usize] == p).count() as i32;
                    if v > bv {
                        bv = v;
                        best = Some(i);
                    }
                }
                Some(Action::Item { k, to: best })
            }
        }
    }

    /// ふつうの評価（cpu.js の evalNormal）
    pub fn eval_normal(&mut self, st: &State, a: &Action, p: u8) -> f64 {
        let r = self.r;
        let (e, info, _) = r.act_eat(st, a, p);
        let gain = info.gain;
        let target = r.cfg.target;
        let mut s = 0.0f64;
        if gain[p as usize] != 0 {
            s += if st.scores[p as usize] + gain[p as usize] >= target { 10000.0 } else { 120.0 * gain[p as usize] as f64 };
        }
        for q in 0..3 {
            if q != p as usize {
                s -= 90.0 * gain[q] as f64;
            }
        }
        let (after, hands, fx) = (&e.cells, &e.hands, &e.fixed);
        let (nx, nx2) = ((p + 1) % 3, (p + 2) % 3);
        s += threats(r, after, p, hands, fx) as f64 * 14.0 + buildup(r, after, p) as f64 * 3.0 - buildup(r, after, nx) as f64 * 1.5;
        let reach = if r.cfg.love_bonus { 2 } else { 1 };
        s -= threats(r, after, nx, hands, fx) as f64 * if st.scores[nx as usize] + reach >= target { 60.0 } else { 22.0 };
        s -= threats(r, after, nx2, hands, fx) as f64 * if st.scores[nx2 as usize] + reach >= target { 40.0 } else { 14.0 };
        if matches!(a, Action::Swap { .. }) && gain[p as usize] == 0 {
            s -= 3.0;
        }
        if matches!(a, Action::Place { .. }) {
            s += 2.0;
        }
        let to = target_of(a);
        if r.cfg.party && st.bx.is_some_and(|(at, _)| at == to) {
            s += 12.0;
        }
        let n = r.cfg.size;
        let mid = (n as f64 - 1.0) / 2.0;
        s -= (((to as usize / n) as f64 - mid).abs() + ((to as usize % n) as f64 - mid).abs()) * 0.6;
        s + self.noise(4.0)
    }

    /// やさしいの評価（cpu.js の evalEasy）
    pub fn eval_easy(&mut self, st: &State, a: &Action, p: u8) -> f64 {
        let r = self.r;
        let (_, info, c) = r.act_eat(st, a, p);
        let mut s = 0.0f64;
        for q in 0..3 {
            s += if q == p as usize { 100.0 } else { -100.0 } * info.gain[q] as f64;
        }
        let to = target_of(a);
        for q in [(p + 1) % 3, (p + 2) % 3] {
            if open_spots(r, &st.cells, q).contains(&to) {
                s += 30.0;
            }
        }
        s += open_spots(r, &c, p).len() as f64 * 10.0 + r.nb[to as usize].iter().filter(|&&j| c[j as usize] == p).count() as f64 * 2.0;
        if r.cfg.party && st.bx.is_some_and(|(at, _)| at == to) {
            s += 8.0;
        }
        s + self.noise(3.0)
    }

    /// 次の人が打ち終わった盤を、p から見て点数にする
    fn board_value(&self, t: &State, p: u8) -> f64 {
        let r = self.r;
        let (nx, nx2, target) = ((p + 1) % 3, (p + 2) % 3, r.cfg.target);
        if t.scores[p as usize] >= target {
            return 1e6;
        }
        if t.scores[nx as usize] >= target || t.scores[nx2 as usize] >= target {
            return -1e6;
        }
        let mut v = t.scores[p as usize] as f64 * 300.0 - (t.scores[nx as usize] + t.scores[nx2 as usize]) as f64 * 150.0;
        v += threats(r, &t.cells, p, &t.hands, &t.fixed) as f64 * 14.0 + buildup(r, &t.cells, p) as f64 * 3.0;
        let reach = if r.cfg.love_bonus { 2 } else { 1 };
        v -= threats(r, &t.cells, nx2, &t.hands, &t.fixed) as f64 * if t.scores[nx2 as usize] + reach >= target { 60.0 } else { 22.0 };
        v -= threats(r, &t.cells, nx, &t.hands, &t.fixed) as f64 * 14.0;
        v
    }

    fn pick_hard(&mut self, st: &State, p: u8) -> Action {
        let r = self.r;
        let mut cand: Vec<(Action, f64)> = moves(r, st, p).into_iter().map(|a| (a, 0.0)).collect();
        for c in cand.iter_mut() {
            c.1 = self.eval_normal(st, &c.0, p);
        }
        cand.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap());
        cand.truncate(10);
        let (mut best, mut bs) = (cand[0].0, f64::NEG_INFINITY);
        for &(a, _) in &cand {
            let s1 = r.act_eat(st, &a, p).0;
            if s1.scores[p as usize] >= r.cfg.target {
                return a;
            }
            let nx = (p + 1) % 3;
            let (mut b, mut bv) = (None, f64::NEG_INFINITY);
            for x in moves(r, &s1, nx) {
                let v = self.eval_normal(&s1, &x, nx);
                if v > bv {
                    bv = v;
                    b = Some(x);
                }
            }
            let t = match b {
                Some(x) => r.act_eat(&s1, &x, nx).0,
                None => s1,
            };
            let v = self.board_value(&t, p) + self.noise(2.0);
            if v > bs {
                bs = v;
                best = a;
            }
        }
        best
    }

    /// p の打つ手を選ぶ（cpu.js の choose）。打てる手がなければ None
    pub fn choose(&mut self, st: &State, p: u8, level: Level) -> Option<Action> {
        if self.r.cfg.party {
            if let Some(it) = self.item_plan(st, p) {
                return Some(it);
            }
        }
        let acts = moves(self.r, st, p);
        if acts.is_empty() {
            return None;
        }
        if level == Level::Hard {
            return Some(self.pick_hard(st, p));
        }
        let (mut best, mut bs) = (acts[0], f64::NEG_INFINITY);
        for a in &acts {
            let s = if level == Level::Easy { self.eval_easy(st, a, p) } else { self.eval_normal(st, a, p) };
            if s > bs {
                bs = s;
                best = *a;
            }
        }
        Some(best)
    }
}

/// 評価対局で使う CPU の席
pub struct CpuAgent {
    pub level: Level,
    pub rng: Rng,
}

impl Agent for CpuAgent {
    fn choose(&mut self, sr: &Arc<SetRules>, s: &SetState) -> Option<Action> {
        let mut cpu = Cpu { r: &sr.rules, rng: Some(&mut self.rng) };
        // アイテムしか打てない（ほかに手がない）ときは、合法手からアイテムを使う
        cpu.choose(&s.game, s.game.turn, self.level).or_else(|| sr.actions(s).first().copied())
    }
}
