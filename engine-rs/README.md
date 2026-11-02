# engine-rs

おかしならべの学習AI用の Rust コード（計画は `../docs/ai-plan.md`）。

| クレート | 内容 |
|---|---|
| `core`（okashi-core） | ルールエンジン。rules.js をそのまま写したもの |

## 照合（rules.js と同じか）

okashi-narabe 直下で：

```
node tools/gen-fixtures.js 1000
cd engine-rs
cargo test --release -- --nocapture
```

ルール（盤の大きさ・並べる数・手持ち・目標点・恋ボーナス・わいわい・時間切れの手数）を対局ごとにくじ引きし、ランダムと「やさしい」CPU の手で指した対局を1手ずつ再生して、合法手の並び・指した後の状態・終局が一致するかを確かめる。

## 速さ

```
cargo run --release --example perf -- 20000 7 8
```

ランダムに終局まで指す：1スレッドで約155万手/秒（7×7・手持ち8）。
