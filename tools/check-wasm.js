// ブラウザ版の学習AI（web/ai.js の encode と engine-rs/wasm）を rules.js と照合する。
//   cd engine-rs && cargo build -p okashi-wasm --release --target wasm32-unknown-unknown && cd .. && node tools/check-wasm.js
// 照合データ（engine-rs/core/tests/fixtures/fixtures.txt、tools/gen-fixtures.js で作る）の対局を rules.js で指し直し、毎手の局面で
//   ・ai.js の encode → wasm で読み直して set.rs の encode で書き直した 196 バイトが、ai.js の encode と一致するか
//   ・wasm の合法手の並び（方策番号）が rules.js の actions と一致するか
// を見る。
'use strict';
const fs = require('fs'), path = require('path');
const R = require('../rules.js');
const AI = require('../web/ai.js');

const DIR8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
function policyIndex(n, a) {
  const pad = i => Math.floor(i / n) * 9 + (i % n);
  const dir = (f, t) => DIR8.findIndex(([dr, dc]) => dr === Math.floor(t / n) - Math.floor(f / n) && dc === (t % n) - (f % n));
  if (a.t === 'place') return pad(a.to);
  if (a.t === 'move') return (1 + dir(a.from, a.to)) * 81 + pad(a.from);
  if (a.t === 'swap') return (9 + dir(a.from, a.to)) * 81 + pad(a.from);
  return { arrow: 17 * 81 + pad(a.to), dog: 18 * 81 + pad(a.to), rain: 19 * 81, dove: 19 * 81 + 1 }[a.k];
}
const ITEM_CODE = { arrow: 'A', dog: 'D', rain: 'R', dove: 'V' };
const actStr = a => a.t === 'place' ? 'p' + a.to : a.t === 'move' ? 'm' + a.from + '-' + a.to : a.t === 'swap' ? 's' + a.from + '-' + a.to
  : 'i' + ITEM_CODE[a.k] + (a.to === null ? '-' : a.to);

(async () => {
  await AI.initWasm(fs.readFileSync(path.join(__dirname, '..', 'web', 'okashi_wasm.wasm')));
  const w = AI.w;
  const text = fs.readFileSync(path.join(__dirname, '..', 'engine-rs', 'core', 'tests', 'fixtures', 'fixtures.txt'), 'utf8');
  let cfg, st, hand, games = 0, plies = 0, bad = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('G ')) {
      const v = line.slice(2).split(' ').map(Number);
      cfg = { size: v[0], need: v[1], target: v[3], loveBonus: v[4] === 1, party: v[5] === 1, maxMoves: v[6] };
      hand = v[2];
      st = R.newState(cfg, hand, v[7], v[8]);
      games++;
      continue;
    }
    if (line === 'N') continue;
    const played = line.split('|')[1];
    const root = AI.encode(cfg, st, { hand });
    const ctx = AI.newSearch(root, 0, 1);
    const enc = new Uint8Array(w.memory.buffer, w.search_root_encode(ctx), 196);
    const n = w.search_result(ctx);
    const pidx = Array.from(new Int32Array(w.memory.buffer, w.search_pidx_ptr(ctx), n));
    const acts = R.actions(cfg, st, st.turn);
    const want = acts.map(a => policyIndex(cfg.size, a));
    const diff = [...Array(196).keys()].filter(i => enc[i] !== root[i]);
    if (diff.length || pidx.join() !== want.join()) {
      if (bad++ < 5) console.log(`対局${games} ${st.moves}手目: encode の違うバイト ${diff.map(i => `${i}(${root[i]}→${enc[i]})`).join(' ')} / 合法手 wasm ${n} rules.js ${acts.length}`);
    }
    w.search_free(ctx);
    st = R.step(cfg, st, acts.find(a => actStr(a) === played)).state;
    plies++;
  }
  console.log(`${games}局・${plies}局面を照合：${bad ? bad + '局面で不一致' : 'すべて一致'}`);
  process.exit(bad ? 1 : 0);
})();
