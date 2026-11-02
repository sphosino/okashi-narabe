// Rust版CPU（engine-rs/mcts/src/cpu.rs）の照合用データを、cpu.js から作る
//   node tools/gen-cpu-fixtures.js [対局数=150]
// Math.random を 0 にして揺らぎをなくし、毎手について「ふつう」「やさしい」の全部の手の評価、「つよい」の選んだ手、アイテムの使いどきを書く。
'use strict';
const fs = require('fs'), path = require('path');
Math.random = () => 0;
const R = require('../rules.js'), CPU = require('../cpu.js');
const N = +process.argv[2] || 150;
const out = path.join(__dirname, '..', 'engine-rs', 'mcts', 'tests', 'fixtures', 'cpu.txt');

let seed = 777;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 16777216; };
const pick = xs => xs[Math.floor(rand() * xs.length)];
const ITEM_CODE = { arrow: 'A', dog: 'D', rain: 'R', dove: 'V' };
const actStr = a => !a ? '-' : a.t === 'place' ? 'p' + a.to : a.t === 'move' ? 'm' + a.from + '-' + a.to : a.t === 'swap' ? 's' + a.from + '-' + a.to
  : 'i' + ITEM_CODE[a.k] + (a.to === null ? '-' : a.to);

const lines = [];
let plies = 0;
for (let g = 0; g < N; g++) {
  const size = 5 + Math.floor(rand() * 5), need = size >= 6 && rand() < 0.3 ? 5 : 4;
  const cfg = { size, need, target: 1 + Math.floor(rand() * 5), loveBonus: rand() < 0.7, maxMoves: pick([150, 60]), party: rand() < 0.4 };
  const hand = 4 + Math.floor(rand() * 7), start = Math.floor(rand() * 3), gseed = Math.floor(rand() * 4294967296);
  lines.push(['G', size, need, hand, cfg.target, +cfg.loveBonus, +cfg.party, cfg.maxMoves, start, gseed].join(' '));
  let st = R.newState(cfg, hand, start, gseed);
  while (true) {
    const acts = R.actions(cfg, st, st.turn);
    if (!acts.length) break;
    const p = st.turn, mv = acts.filter(a => a.t !== 'item');
    const normal = mv.map(a => CPU.evalNormal(cfg, st, a, p)), easy = mv.map(a => CPU.evalEasy(cfg, st, a, p));
    const hard = CPU.choose(cfg, st, p, 'hard'), item = cfg.party ? CPU.itemPlan(cfg, st, p) : null;
    const a = rand() < 0.5 ? pick(acts) : (CPU.choose(cfg, st, p, 'normal') || pick(acts));
    lines.push([actStr(a), normal.join(','), easy.join(','), actStr(hard), actStr(item)].join('|'));
    const r = R.step(cfg, st, a); st = r.state; plies++;
    if (r.over) break;
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${N}局・${plies}手を ${out} に書いた`);
