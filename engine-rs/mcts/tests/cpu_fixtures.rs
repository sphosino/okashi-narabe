//! cpu.js との照合。照合データは okashi-narabe 直下で `node tools/gen-cpu-fixtures.js 150` で作る。
//! 揺らぎなしで、毎手の「ふつう」「やさしい」の全部の手の評価・「つよい」の選んだ手・アイテムの使いどきが cpu.js と一致するかを見る。

use okashi_core::*;
use okashi_mcts::cpu::{moves, Cpu, Level};

fn item_code(k: Item) -> char {
    match k {
        Item::Arrow => 'A',
        Item::Dog => 'D',
        Item::Rain => 'R',
        Item::Dove => 'V',
    }
}

fn act_str(a: Option<Action>) -> String {
    match a {
        None => "-".into(),
        Some(Action::Place { to }) => format!("p{to}"),
        Some(Action::Move { from, to }) => format!("m{from}-{to}"),
        Some(Action::Swap { from, to }) => format!("s{from}-{to}"),
        Some(Action::Item { k, to }) => format!("i{}{}", item_code(k), to.map_or("-".to_string(), |t| t.to_string())),
    }
}

fn nums(s: &str) -> Vec<f64> {
    if s.is_empty() {
        vec![]
    } else {
        s.split(',').map(|x| x.parse().unwrap()).collect()
    }
}

#[test]
fn matches_cpu_js() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cpu.txt");
    let text = std::fs::read_to_string(path).expect("照合データがない：node tools/gen-cpu-fixtures.js 150 で作る");
    let mut rules: Option<Rules> = None;
    let mut st: Option<State> = None;
    let mut plies = 0;
    for (ln, line) in text.lines().enumerate() {
        let ln = ln + 1;
        if let Some(rest) = line.strip_prefix("G ") {
            let v: Vec<u64> = rest.split(' ').map(|x| x.parse().unwrap()).collect();
            let r = Rules::new(Config {
                size: v[0] as usize,
                need: v[1] as usize,
                target: v[3] as i32,
                love_bonus: v[4] == 1,
                party: v[5] == 1,
                max_moves: v[6] as u32,
            });
            st = Some(r.new_state(v[2] as i32, v[7] as u8, v[8] as u32));
            rules = Some(r);
            continue;
        }
        let r = rules.as_ref().unwrap();
        let s = st.take().unwrap();
        let f: Vec<&str> = line.split('|').collect();
        let p = s.turn;
        let mut cpu = Cpu { r, rng: None };
        let mv = moves(r, &s, p);
        let (want_n, want_e) = (nums(f[1]), nums(f[2]));
        assert_eq!(mv.len(), want_n.len(), "{ln}行：手の数");
        for (i, a) in mv.iter().enumerate() {
            let (n, e) = (cpu.eval_normal(&s, a, p), cpu.eval_easy(&s, a, p));
            assert!((n - want_n[i]).abs() < 1e-6, "{ln}行：ふつうの評価 {:?} {} vs {}", a, n, want_n[i]);
            assert!((e - want_e[i]).abs() < 1e-6, "{ln}行：やさしいの評価 {:?} {} vs {}", a, e, want_e[i]);
        }
        assert_eq!(act_str(cpu.choose(&s, p, Level::Hard)), f[3], "{ln}行：つよいの手");
        assert_eq!(act_str(if r.cfg.party { cpu.item_plan(&s, p) } else { None }), f[4], "{ln}行：アイテム");
        let acts = r.actions(&s, p);
        let a = acts.iter().find(|a| act_str(Some(**a)) == f[0]).expect("指した手が合法手にない");
        st = Some(r.step(&s, a).0);
        plies += 1;
    }
    println!("{plies}手で cpu.js と一致");
}
