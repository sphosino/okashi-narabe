use okashi_core::*;

#[test]
fn rank_share_splits_ties() {
    let r = SetRules::rank_share(&[10, 10, 3]);
    assert_eq!(r[0], [0.5, 0.5, 0.0]);
    assert_eq!(r[2], [0.0, 0.0, 1.0]);
    let r = SetRules::rank_share(&[4, 4, 4]);
    assert!((r[1][2] - 1.0 / 3.0).abs() < 1e-6);
}

/// 盤の大きさごとに、ランダムに指したセットで方策の番号がぶつからず、範囲内か。セットが最後まで進むか
#[test]
fn policy_index_unique_and_set_runs() {
    let mut x: u64 = 0x1234_5678;
    for size in 5..=9 {
        for party in [false, true] {
            let sr = SetRules::new(
                Config { size, need: 4, target: 2, love_bonus: true, max_moves: 80, party },
                SetConfig { hand: 6, games: 3, win_bonus: 2, first: 1, a: [0.0, 0.5, 1.0] },
            );
            let mut s = sr.initial(7);
            let mut games_seen = 0;
            let mut buf = Vec::new();
            while !s.over {
                let acts = sr.actions(&s);
                if acts.is_empty() {
                    s = sr.end_stuck(&s);
                    continue;
                }
                let mut idx: Vec<usize> = acts.iter().map(|a| sr.policy_index(a)).collect();
                assert!(idx.iter().all(|&i| i < NUM_POLICY));
                idx.sort();
                idx.dedup();
                assert_eq!(idx.len(), acts.len(), "方策の番号がぶつかった（盤 {size}）");
                buf.clear();
                sr.encode(&s, &mut buf);
                assert_eq!(buf.len(), STATE_BYTES);
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let before = s.game_idx;
                s = sr.step(&s, &acts[(x % acts.len() as u64) as usize]).0;
                if s.over || s.game_idx != before {
                    games_seen += 1;
                }
            }
            assert_eq!(games_seen, 3);
            // 合計点：局の点の合計 + 勝ちボーナス2点が3局ぶん（UNIT 倍）
            assert!(s.totals.iter().sum::<i32>() >= 3 * 2 * UNIT);
            let u = sr.utility(&s.totals);
            assert!(u.iter().all(|&v| (0.0..=1.0).contains(&v)));
        }
    }
}
