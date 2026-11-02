//! 確かめ用：ランダム評価の MCTS 1席 vs ランダム2席（席は毎セット回す）。互角なら33%
//!   cargo run --release --example arena -- [セット数=60] [訪問数=200] [局数=1]
use okashi_core::*;
use okashi_mcts::*;
use std::sync::Arc;

fn main() {
    let a: Vec<u32> = std::env::args().skip(1).map(|x| x.parse().unwrap()).collect();
    let (sets, visits, games) = (*a.first().unwrap_or(&60), *a.get(1).unwrap_or(&200), *a.get(2).unwrap_or(&1) as u8);
    let mut won = 0f32;
    let t = std::time::Instant::now();
    for k in 0..sets {
        let me = (k % 3) as usize;
        let sr = Arc::new(SetRules::new(
            Config { size: 6, need: 4, target: 3, love_bonus: true, max_moves: MAX_MOVES, party: false },
            SetConfig { hand: 6, games, win_bonus: 2, first: (k / 3 % 3) as u8, a: [0.0; 3] },
        ));
        let mut agents: Vec<Box<dyn Agent>> = (0..3)
            .map(|i| -> Box<dyn Agent> {
                if i == me {
                    Box::new(MctsAgent { eval: RolloutEval { rng: Rng::new(k as u64 + 99), rollouts: 1 }, visits, cfg: SearchConfig::default() })
                } else {
                    Box::new(RandomAgent::new(k as u64 * 3 + i as u64))
                }
            })
            .collect();
        let mut s = settle(&sr, sr.initial(k + 1));
        while !s.over {
            let act = agents[s.game.turn as usize].choose(&sr, &s).unwrap();
            s = settle(&sr, sr.step(&s, &act).0);
        }
        won += sr.utility(&s.totals)[me];
    }
    println!("{sets}セット（{games}局制）：MCTS:{visits} の順位点の平均 {:.1}%（{:.1}秒）", won / sets as f32 * 100.0, t.elapsed().as_secs_f64());
}
