//! ランダムに終局まで指す速さ（合法手生成＋1手）
//!   cargo run --release --example perf -- [局数=20000] [盤=7] [手持ち=8]
use okashi_core::*;
use std::time::Instant;

fn main() {
    let a: Vec<usize> = std::env::args().skip(1).map(|x| x.parse().unwrap()).collect();
    let (games, size, hand) = (*a.first().unwrap_or(&20000), *a.get(1).unwrap_or(&7), *a.get(2).unwrap_or(&8));
    let r = Rules::new(Config { size, need: 4, target: 3, love_bonus: true, max_moves: MAX_MOVES, party: false });
    let mut x: u64 = 88172645463325252;
    let mut acts = Vec::new();
    let (mut plies, mut wins) = (0u64, 0u64);
    let t = Instant::now();
    for g in 0..games {
        let mut st = r.new_state(hand as i32, (g % 3) as u8, g as u32 + 1);
        loop {
            r.actions_into(&st, st.turn, &mut acts);
            if acts.is_empty() {
                break;
            }
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let (ns, info) = r.step(&st, &acts[(x % acts.len() as u64) as usize]);
            st = ns;
            plies += 1;
            if let Some(e) = info.end {
                wins += (e == EndReason::Win) as u64;
                break;
            }
        }
    }
    let s = t.elapsed().as_secs_f64();
    println!("{games}局・{plies}手（並べて終わった局 {wins}）：{:.0}手/秒", plies as f64 / s);
}
