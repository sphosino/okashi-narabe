//! ブラウザ版の探索（WebAssembly、wasm-bindgen なしの素の C ABI。三人将棋の engine-rs/wasm と同じ形）。
//!
//! ブラウザ側（web/ai.js）の流れ：
//!   ctx = search_new(根の局面 200 バイト, 探索回数, まとめる数, c_puct)
//!   loop { k = search_next(ctx); if k == 0 break;          // 評価待ちの葉を最大「まとめる数」個用意する
//!          入力 k×45×81（search_planes_ptr）を ONNX Runtime Web で推論して、
//!          方策のロジット k×1541 と順位のロジット k×9 をそのまま search_submit(ctx, …) に渡す }
//!   n = search_result(ctx)  // 根の各手の訪問数（rules.js の actions と同じ並び）と根の価値
//!   search_free(ctx)
//!
//! 根の局面は、set.rs の encode と同じ 196 バイトのあとに、わいわいの種（u32 LE）を足した 200 バイト（web/ai.js の encode が作る）。
//! 合法手の並びは rules.js と同じ（core/tests/js_fixtures.rs）なので、結果の i 番目は rules.js の actions の i 番目の手。

use okashi_core::*;
use okashi_mcts::{EvalOut, Leaf, Search, SearchConfig};
use std::sync::Arc;

const ROOT_BYTES: usize = STATE_BYTES + 4;

fn item_of(id: u8) -> Option<Item> {
    (1..=4).contains(&id).then(|| ITEMS[id as usize - 1])
}

/// 根の局面（200 バイト）→ セットのルールと局面
fn decode_root(s: &[u8]) -> (SetRules, SetState) {
    let n = s[177] as usize;
    let cfg = Config {
        size: n,
        need: s[178] as usize,
        target: s[179] as i32,
        love_bonus: s[180] != 0,
        max_moves: s[181] as u32,
        party: s[182] != 0,
    };
    let at = |p: usize| ((p / MAX_SIZE) * n + p % MAX_SIZE) as u8;
    let mut cells = [EMPTY; CELLS];
    let mut fixed = Vec::new();
    for r in 0..n {
        for c in 0..n {
            let p = r * MAX_SIZE + c;
            if s[p] < 3 {
                cells[r * n + c] = s[p];
            }
            if s[81 + p] != 0 {
                fixed.push(at(p));
            }
        }
    }
    let turn = s[174];
    let game = State {
        cells,
        hands: [s[162] as i32, s[163] as i32, s[164] as i32],
        scores: [s[165] as i32, s[166] as i32, s[167] as i32],
        fixed,
        turn,
        moves: u16::from_le_bytes([s[175], s[176]]) as u32,
        items: [item_of(s[183]), item_of(s[184]), item_of(s[185])],
        bx: ((s[186] as usize) < CELLS).then(|| (at(s[186] as usize), item_of(s[187]).unwrap_or(Item::Arrow))),
        seed: u32::from_le_bytes([s[196], s[197], s[198], s[199]]),
    };
    let game_idx = s[189];
    let set = SetConfig {
        hand: s[194] as i32,
        games: s[188].max(1),
        win_bonus: s[190] as i32,
        first: (turn + 3 - game_idx % 3) % 3,
        a: [s[191] as f32 / 100.0, s[192] as f32 / 100.0, s[193] as f32 / 100.0],
    };
    let totals = [0, 1, 2].map(|q| u16::from_le_bytes([s[168 + q * 2], s[169 + q * 2]]) as i32);
    (SetRules::new(cfg, set), SetState { game, game_idx, totals, over: false, last_scores: [0; 3] })
}

pub struct Ctx {
    search: Search,
    pending: Vec<(Leaf, Vec<Action>, u8)>,
    visits: u32,
    batch: usize,
    planes: Vec<f32>,
    enc: Vec<u8>,
    visits_out: Vec<u32>,
    pidx_out: Vec<i32>,
    root_value: [f32; 3],
}

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// alloc で確保した領域を、同じ大きさで返すこと
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

/// # Safety
/// root は 200 バイト
#[no_mangle]
pub unsafe extern "C" fn search_new(root: *const u8, visits: u32, batch: u32, c_puct: f32) -> *mut Ctx {
    let s = std::slice::from_raw_parts(root, ROOT_BYTES);
    let (sr, st) = decode_root(s);
    let cfg = SearchConfig { c_puct, fpu_reduction: 0.2, dirichlet_total: 0.0, dirichlet_weight: 0.0 };
    Box::into_raw(Box::new(Ctx {
        search: Search::new(Arc::new(sr), st, cfg),
        pending: Vec::new(),
        visits,
        batch: batch.max(1) as usize,
        planes: Vec::new(),
        enc: Vec::new(),
        visits_out: Vec::new(),
        pidx_out: Vec::new(),
        root_value: [0.0; 3],
    }))
}

/// 評価待ちの葉を用意して、その数を返す（0 なら探索終了）
///
/// # Safety
/// ctx は search_new が返したもの
#[no_mangle]
pub unsafe extern "C" fn search_next(ctx: *mut Ctx) -> u32 {
    let c = &mut *ctx;
    c.pending.clear();
    let mut guard = 0;
    while c.pending.len() < c.batch && (c.search.root_visits() as usize + c.pending.len()) < c.visits as usize && guard < 4 * c.batch + 64 {
        guard += 1;
        let leaf = c.search.select();
        if leaf.terminal.is_some() {
            c.search.expand(leaf, &[], None);
            continue;
        }
        if c.pending.iter().any(|(p, _, _)| p.id() == leaf.id()) {
            break; // 同じ葉をもう一度選んだ：このまとまりはここまで
        }
        let acts = c.search.leaf_actions(&leaf);
        let turn = c.search.leaf_state(&leaf).game.turn;
        c.search.add_virtual(&leaf);
        c.pending.push((leaf, acts, turn));
    }
    let k = c.pending.len();
    c.planes.resize(k * PLANES_LEN, 0.0);
    for (i, (leaf, _, _)) in c.pending.iter().enumerate() {
        c.enc.clear();
        c.search.sr.encode(c.search.leaf_state(leaf), &mut c.enc);
        planes(&c.enc, &mut c.planes[i * PLANES_LEN..(i + 1) * PLANES_LEN]);
    }
    k as u32
}

#[no_mangle]
pub unsafe extern "C" fn search_planes_ptr(ctx: *mut Ctx) -> *const f32 {
    (*ctx).planes.as_ptr()
}

/// search_next の葉の推論結果を返す。policy: f32[k×1541]（ロジット）、rank: f32[k×9]（手番から見た席×順位のロジット）
///
/// # Safety
/// 大きさは直前の search_next と合わせること
#[no_mangle]
pub unsafe extern "C" fn search_submit(ctx: *mut Ctx, policy: *const f32, rank: *const f32) {
    let c = &mut *ctx;
    let pending = std::mem::take(&mut c.pending);
    let pol = std::slice::from_raw_parts(policy, pending.len() * NUM_POLICY);
    let rk = std::slice::from_raw_parts(rank, pending.len() * 9);
    let a = c.search.sr.set.a;
    for (bi, (leaf, acts, turn)) in pending.into_iter().enumerate() {
        // 合法手だけで softmax
        let lg: Vec<f32> = acts.iter().map(|m| pol[bi * NUM_POLICY + c.search.sr.policy_index(m)]).collect();
        let mx = lg.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let ex: Vec<f32> = lg.iter().map(|&x| (x - mx).exp()).collect();
        let sum: f32 = ex.iter().sum::<f32>().max(1e-30);
        let priors = ex.iter().map(|&e| e / sum).collect();
        // 順位の予想 → 各席の順位点の見込み（1位の確率 + a × 2位の確率）
        let mut value = [0f32; 3];
        for j in 0..3 {
            let r = &rk[bi * 9 + j * 3..bi * 9 + j * 3 + 3];
            let m = r[0].max(r[1]).max(r[2]);
            let e = [(r[0] - m).exp(), (r[1] - m).exp(), (r[2] - m).exp()];
            let s = e[0] + e[1] + e[2];
            let q = (turn as usize + j) % 3;
            value[q] = (e[0] + a[q] * e[1]) / s;
        }
        c.search.expand_virtual(leaf, &acts, Some(EvalOut { priors, value }));
    }
}

/// 根の各手の訪問数（rules.js の actions と同じ並び）と方策番号・根の価値を用意して、手の数を返す
///
/// # Safety
/// ctx は search_new が返したもの
#[no_mangle]
pub unsafe extern "C" fn search_result(ctx: *mut Ctx) -> u32 {
    let c = &mut *ctx;
    let root = c.search.root().clone();
    let acts = c.search.sr.actions(&root);
    let counts = c.search.root_visit_counts();
    c.visits_out = acts.iter().map(|a| counts.iter().find(|(b, _)| b == a).map_or(0, |&(_, n)| n)).collect();
    c.pidx_out = acts.iter().map(|a| c.search.sr.policy_index(a) as i32).collect();
    c.root_value = c.search.root_value();
    acts.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn search_visits_ptr(ctx: *mut Ctx) -> *const u32 {
    (*ctx).visits_out.as_ptr()
}

/// search_result の各手の方策番号（照合用）
#[no_mangle]
pub unsafe extern "C" fn search_pidx_ptr(ctx: *mut Ctx) -> *const i32 {
    (*ctx).pidx_out.as_ptr()
}

/// 根の価値（各席の順位点の見込み f32×3）
#[no_mangle]
pub unsafe extern "C" fn search_value_ptr(ctx: *mut Ctx) -> *const f32 {
    (*ctx).root_value.as_ptr()
}

/// 根の局面を set.rs の encode で書き直した 196 バイト（照合用：web/ai.js の encode と同じになるはず）
///
/// # Safety
/// ctx は search_new が返したもの
#[no_mangle]
pub unsafe extern "C" fn search_root_encode(ctx: *mut Ctx) -> *const u8 {
    let c = &mut *ctx;
    c.enc.clear();
    let root = c.search.root().clone();
    c.search.sr.encode(&root, &mut c.enc);
    c.enc.as_ptr()
}

/// # Safety
/// ctx は search_new が返したもの。以後使わないこと
#[no_mangle]
pub unsafe extern "C" fn search_free(ctx: *mut Ctx) {
    drop(Box::from_raw(ctx));
}
