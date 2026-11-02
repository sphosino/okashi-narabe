//! 比較用のエージェント（評価対局で使う）。

use crate::eval::Evaluator;
use crate::rng::Rng;
use crate::search::{Search, SearchConfig};
use okashi_core::{Action, SetRules, SetState};
use std::sync::Arc;

pub trait Agent {
    fn choose(&mut self, sr: &Arc<SetRules>, s: &SetState) -> Option<Action>;
}

pub struct RandomAgent {
    rng: Rng,
}

impl RandomAgent {
    pub fn new(seed: u64) -> Self {
        RandomAgent { rng: Rng::new(seed) }
    }
}

impl Agent for RandomAgent {
    fn choose(&mut self, sr: &Arc<SetRules>, s: &SetState) -> Option<Action> {
        let acts = sr.actions(s);
        (!acts.is_empty()).then(|| acts[self.rng.below(acts.len())])
    }
}

pub struct MctsAgent<E: Evaluator> {
    pub eval: E,
    pub visits: u32,
    pub cfg: SearchConfig,
}

impl<E: Evaluator> Agent for MctsAgent<E> {
    fn choose(&mut self, sr: &Arc<SetRules>, s: &SetState) -> Option<Action> {
        if sr.actions(s).is_empty() {
            return None;
        }
        let mut search = Search::new(sr.clone(), s.clone(), self.cfg.clone());
        search.run(&mut self.eval, self.visits, None);
        Some(search.best_action())
    }
}
