//! 局面（set.rs の encode の 196 バイト）→ ネットの入力チャンネル。python/okashiml/features.py の planes と同じ（tests/features.rs で照合）。
//! ブラウザ版（engine-rs/wasm）で、推論の前にここで入力を作る。

use crate::set::{STATE_BYTES, UNIT};
use crate::CELLS;

/// 入力チャンネルの数（盤 12 ＋ 全体の値 33）
pub const IN_CHANNELS: usize = 12 + 33;
/// 1局面の入力の大きさ [45, 9, 9]
pub const PLANES_LEN: usize = IN_CHANNELS * CELLS;

/// s（196 バイト）の入力チャンネルを out（45×81）に書く
pub fn planes(s: &[u8], out: &mut [f32]) {
    debug_assert!(s.len() >= STATE_BYTES && out.len() >= PLANES_LEN);
    let out = &mut out[..PLANES_LEN];
    out.fill(0.0);
    let turn = s[174] as usize;
    let seat = |j: usize| (turn + j) % 3;
    let mut set = |ch: usize, i: usize, v: f32| out[ch * CELLS + i] = v;
    // 盤：お菓子 3（手番から見た持ち主）/ 空き / 盤の外 / 恋モード 3 / アイテム箱 4
    for i in 0..CELLS {
        let c = s[i] as usize;
        if c < 3 {
            let rel = (c + 3 - turn) % 3;
            set(rel, i, 1.0);
            if s[81 + i] != 0 {
                set(5 + rel, i, 1.0);
            }
        } else if c == 3 {
            set(3, i, 1.0);
        } else {
            set(4, i, 1.0);
        }
    }
    if (s[186] as usize) < CELLS {
        let k = (s[187] as usize).clamp(1, 4) - 1;
        set(8 + k, s[186] as usize, 1.0);
    }
    // 全体の値（盤全体に広げる）
    let target = (s[179] as f32).max(1.0);
    let games = s[188] as f32;
    let mut g = Vec::with_capacity(33);
    g.extend((0..3).map(|j| s[162 + seat(j)] as f32 / 10.0));
    g.extend((0..3).map(|j| s[165 + seat(j)] as f32 / target));
    g.extend((0..3).map(|j| {
        let q = seat(j);
        (s[168 + q * 2] as f32 + s[169 + q * 2] as f32 * 256.0) / UNIT as f32 / 20.0
    }));
    for j in 0..3 {
        let it = s[183 + seat(j)] as usize;
        g.extend((1..5).map(|k| (it == k) as u8 as f32));
    }
    g.extend([
        target / 5.0,
        (s[178] == 5) as u8 as f32,
        s[180] as f32,
        s[182] as f32,
        s[177] as f32 / 9.0,
        (s[175] as f32 + s[176] as f32 * 256.0) / 150.0,
    ]);
    g.extend([games / 11.0, s[189] as f32 / 11.0, (games - s[189] as f32) / 11.0, s[190] as f32 / 3.0, s[194] as f32 / 10.0]);
    g.push(s[191 + turn] as f32 / 100.0);
    debug_assert_eq!(g.len(), 33);
    for (k, &v) in g.iter().enumerate() {
        out[(12 + k) * CELLS..(13 + k) * CELLS].fill(v);
    }
}
