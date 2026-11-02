//! rules.js との照合。照合データは okashi-narabe 直下で `node tools/gen-fixtures.js 300` で作る。
//! 毎手について、合法手の並び・指した後の状態・終局（終わり方・勝者・パスした人）が rules.js と一致するかを見る。

use okashi_core::*;

fn item_code(k: Item) -> char {
    match k {
        Item::Arrow => 'A',
        Item::Dog => 'D',
        Item::Rain => 'R',
        Item::Dove => 'V',
    }
}

fn act_str(a: &Action) -> String {
    match *a {
        Action::Place { to } => format!("p{to}"),
        Action::Move { from, to } => format!("m{from}-{to}"),
        Action::Swap { from, to } => format!("s{from}-{to}"),
        Action::Item { k, to } => format!("i{}{}", item_code(k), to.map_or("-".to_string(), |t| t.to_string())),
    }
}

fn join<T: ToString>(xs: &[T]) -> String {
    xs.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

fn state_str(r: &Rules, st: &State) -> String {
    let cells: String = st.cells[..r.cells()]
        .iter()
        .map(|&v| if v == EMPTY { '.' } else { (b'0' + v) as char })
        .collect();
    let mut s = format!(
        "{cells};{};{};{};{};{}",
        join(&st.hands),
        join(&st.scores),
        join(&st.fixed),
        st.turn,
        st.moves
    );
    if r.cfg.party {
        let items: String = st.items.iter().map(|k| k.map_or('-', item_code)).collect();
        let bx = st.bx.map_or("-".to_string(), |(at, k)| format!("{at}{}", item_code(k)));
        s += &format!(";{items};{bx}");
    }
    s
}

fn end_str(info: &StepInfo) -> String {
    let reason = match info.end {
        None => "-",
        Some(EndReason::Win) => "win",
        Some(EndReason::Timeout) => "timeout",
        Some(EndReason::Stuck) => "stuck",
    };
    format!("{reason}:{}:{}", join(&info.winners), join(&info.skipped))
}

#[test]
fn matches_rules_js() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fixtures.txt");
    let text = std::fs::read_to_string(path).expect("照合データがない：node tools/gen-fixtures.js 300 で作る");
    let mut rules: Option<Rules> = None;
    let mut st: Option<State> = None;
    let (mut games, mut plies) = (0, 0);
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
            games += 1;
            continue;
        }
        let r = rules.as_ref().unwrap();
        let s = st.as_ref().unwrap();
        let acts = r.actions(s, s.turn);
        if line == "N" {
            assert!(acts.is_empty(), "{ln}行：JS では合法手なし");
            continue;
        }
        let f: Vec<&str> = line.split('|').collect();
        let got: Vec<String> = acts.iter().map(act_str).collect();
        assert_eq!(got.join(" "), f[0], "{ln}行：合法手がちがう");
        let a = acts.iter().find(|a| act_str(a) == f[1]).expect("指した手が合法手にない");
        let (ns, info) = r.step(s, a);
        assert_eq!(state_str(r, &ns), f[2], "{ln}行：指した後の状態がちがう（手 {}）", f[1]);
        assert_eq!(end_str(&info), f[3], "{ln}行：終局がちがう");
        st = Some(ns);
        plies += 1;
    }
    println!("{games}局・{plies}手が rules.js と一致");
}
