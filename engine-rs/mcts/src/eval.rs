//! 評価器：局面と合法手から、各手の事前確率と3人の順位点の見込みを返す。

use crate::rng::Rng;
use crate::search::settle;
use okashi_core::{Action, SetRules, SetState};

pub struct EvalOut {
    /// 合法手と同じ順の事前確率（合計1）
    pub priors: Vec<f32>,
    /// 3人それぞれのセットの順位点の見込み
    pub value: [f32; 3],
}

pub trait Evaluator {
    fn evaluate(&mut self, sr: &SetRules, s: &SetState, actions: &[Action]) -> EvalOut;
}

/// ネットなしの確かめ用：事前確率は一様、価値はセットの終わりまでランダムに指した結果
pub struct RolloutEval {
    pub rng: Rng,
    pub rollouts: u32,
}

impl Evaluator for RolloutEval {
    fn evaluate(&mut self, sr: &SetRules, s: &SetState, actions: &[Action]) -> EvalOut {
        let mut v = [0f32; 3];
        for _ in 0..self.rollouts {
            let mut t = s.clone();
            while !t.over {
                let acts = sr.actions(&t);
                t = settle(sr, sr.step(&t, &acts[self.rng.below(acts.len())]).0);
            }
            let u = sr.utility(&t.totals);
            for k in 0..3 {
                v[k] += u[k] / self.rollouts as f32;
            }
        }
        EvalOut { priors: vec![1.0 / actions.len() as f32; actions.len()], value: v }
    }
}
