//! おかしならべの3人用MCTS（三人将棋の engine-rs/mcts を写して、セット形式に合わせたもの）。
//!
//! - 価値は3人それぞれのセットの順位点の見込みの3つ組。各ノードで手番の人が自分の成分を最大にする。
//! - 局が終わっても読みは止めず、次の局の最初の局面へ進む。終局ノードはセットが終わったときだけ。
//! - 推論をまとめられるように、探索は「葉を選ぶ（[`Search::select`]）」と「評価を反映する（[`Search::expand`]）」に分けてある。

pub mod agents;
pub mod eval;
pub mod rng;
pub mod search;

pub use agents::{Agent, MctsAgent, RandomAgent};
pub use eval::{EvalOut, Evaluator, RolloutEval};
pub use rng::Rng;
pub use search::{settle, Leaf, Search, SearchConfig};
