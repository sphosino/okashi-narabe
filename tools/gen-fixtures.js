// Rust版ルールエンジン（engine-rs/core）の照合用データを、rules.js で指した対局から作る
//   node tools/gen-fixtures.js [対局数=300]
// 盤の大きさ・並べる数・手持ち・目標点・恋ボーナス・わいわい・時間切れの手数を対局ごとにくじ引きし、
// 半分はランダム、半分は「やさしい」CPU の手で指し進める。毎手について、合法手の並び・指した手・指した後の状態・終局を1行に書く。
// 書き方は engine-rs/core/tests/js_fixtures.rs と合わせる。
'use strict';
const fs = require('fs'), path = require('path');
const R = require('../rules.js'), CPU = require('../cpu.js');
const N = +process.argv[2] || 300;
const out = path.join(__dirname, '..', 'engine-rs', 'core', 'tests', 'fixtures', 'fixtures.txt');

let seed = 12345;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 16777216; };
const pick = xs => xs[Math.floor(rand() * xs.length)];

const ITEM_CODE = { arrow: 'A', dog: 'D', rain: 'R', dove: 'V' };
const actStr = a => a.t === 'place' ? 'p' + a.to : a.t === 'move' ? 'm' + a.from + '-' + a.to : a.t === 'swap' ? 's' + a.from + '-' + a.to
  : 'i' + ITEM_CODE[a.k] + (a.to === null ? '-' : a.to);
function stateStr(cfg, st) {
  let s = st.cells.map(v => v === null ? '.' : v).join('') + ';' + st.hands.join(',') + ';' + st.scores.join(',') + ';' + st.fixed.join(',')
    + ';' + st.turn + ';' + st.moves;
  if (cfg.party) s += ';' + st.items.map(k => k ? ITEM_CODE[k] : '-').join('') + ';' + (st.box ? st.box.at + ITEM_CODE[st.box.k] : '-');
  return s;
}

const lines = [];
let plies = 0;
const ends = { win: 0, timeout: 0, stuck: 0, none: 0 };
for (let g = 0; g < N; g++) {
  const size = 5 + Math.floor(rand() * 5), need = size >= 6 && rand() < 0.3 ? 5 : 4;
  const cfg = { size, need, target: 1 + Math.floor(rand() * 5), loveBonus: rand() < 0.7, maxMoves: pick([150, 150, 60, 30]), party: rand() < 0.4 };
  const hand = 4 + Math.floor(rand() * 7), start = Math.floor(rand() * 3), gseed = Math.floor(rand() * 4294967296);
  lines.push(['G', size, need, hand, cfg.target, +cfg.loveBonus, +cfg.party, cfg.maxMoves, start, gseed].join(' '));
  let st = R.newState(cfg, hand, start, gseed);
  while (true) {
    const acts = R.actions(cfg, st, st.turn);
    if (!acts.length) { lines.push('N'); ends.none++; break; }
    const a = rand() < 0.5 ? pick(acts) : (CPU.choose(cfg, st, st.turn, 'easy') || pick(acts));
    const r = R.step(cfg, st, a);
    st = r.state; plies++;
    lines.push([acts.map(actStr).join(' '), actStr(a), stateStr(cfg, st), (r.over ? r.reason : '-') + ':' + r.winners.join(',') + ':' + (r.skipped || []).join(',')].join('|'));
    if (r.over) { ends[r.reason]++; break; }
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${N}局・${plies}手を ${out} に書いた。終わり方：`, ends);
