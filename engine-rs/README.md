# engine-rs

おかしならべの学習AI用の Rust コード（計画は `../docs/ai-plan.md`）。

| クレート | 内容 |
|---|---|
| `core`（okashi-core） | ルールエンジン。rules.js をそのまま写したもの。セット形式・ネットに渡す196バイトの局面・方策の番号（set.rs） |
| `mcts`（okashi-mcts） | 3人用MCTS（局をまたいで読む）、今のCPU（cpu.js をそのまま写したもの。cpu.rs）、比較用エージェント |
| `py`（okashi_rs） | Pythonから使う自己対局ドライバ（数百セットを同時に進め、推論をまとめてPythonに渡す） |

## 照合（rules.js と同じか）

okashi-narabe 直下で：

```
node tools/gen-fixtures.js 1000
cd engine-rs
cargo test --release -- --nocapture
```

ルール（盤の大きさ・並べる数・手持ち・目標点・恋ボーナス・わいわい・時間切れの手数）を対局ごとにくじ引きし、ランダムと「やさしい」CPU の手で指した対局を1手ずつ再生して、合法手の並び・指した後の状態・終局が一致するかを確かめる。

CPU（cpu.rs）も同じように照合する（揺らぎなしで、「ふつう」「やさしい」の全部の手の評価・「つよい」の選んだ手・アイテムの使いどき）：

```
node tools/gen-cpu-fixtures.js 150
cd engine-rs
cargo test --release -p okashi-mcts -- --nocapture
```

## Python から使う

PyTorch は三人将棋の環境（Desktop/shogi3/python/.venv）を借りる。okashi-narabe 直下で：

```
VIRTUAL_ENV=../shogi3/python/.venv ../shogi3/python/.venv/Scripts/maturin.exe develop --release -m engine-rs/py/Cargo.toml
PYTHONIOENCODING=utf-8 ../shogi3/python/.venv/Scripts/python.exe python/scripts/train_loop.py --run r1 --gens 20
```

学習ループは python/scripts/train_loop.py、ネット・入力・学習は python/okashiml/。

## 速さ

```
cargo run --release --example perf -- 20000 7 8
```

ランダムに終局まで指す：1スレッドで約155万手/秒（7×7・手持ち8）。
