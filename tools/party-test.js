// わいわい（アイテムあり）で、実力差がどれくらい残るか・アイテムがどれくらい使われるかを、CPU同士で調べる
//   node tools/party-test.js [試合数]
// 「ふつう」1人 対 「やさしい」2人で、ふつう側の勝率をくらべる（実力差がなければ33%）。席は公平に回す
const R = require('../rules.js'), CPU = require('../cpu.js');
const N = +process.argv[2] || 300;
const base = { size: 6, need: 4, target: 3, loveBonus: true, maxMoves: R.MAXMOVES };

function play(cfg, strong, seed) {
  let st = R.newState(cfg, R.handFor(6, 4, 'auto'), seed % 3, seed * 7919 + 13);
  const used = { arrow: 0, dog: 0, rain: 0, dove: 0 }; let picked = 0, items = 0;
  while (true) {
    const p = st.turn, a = CPU.choose(cfg, st, p, p === strong ? 'normal' : 'easy');
    if (!a) return null;
    const r = R.step(cfg, st, a);
    if (a.t === 'item') { used[a.k]++; items++; }
    if (r.act.picked) picked++;
    st = r.state;
    if (r.over) return { win: r.winners.length === 1 ? r.winners[0] : -1, strong, moves: st.moves, used, picked, items };
  }
}
for (const [name, cfg] of [['ふつう', base], ['わいわい', { ...base, party: true }]]) {
  let w = 0, draws = 0, mv = 0, pk = 0, it = 0; const used = { arrow: 0, dog: 0, rain: 0, dove: 0 };
  for (let g = 0; g < N; g++) {
    const r = play(cfg, g % 3, g + 1); if (!r) continue;
    if (r.win === r.strong) w++; if (r.win < 0) draws++;
    mv += r.moves; pk += r.picked; it += r.items; for (const k in used) used[k] += r.used[k];
  }
  console.log(`${name}：ふつうCPUの勝率 ${(w / N * 100).toFixed(1)}%（引き分け ${(draws / N * 100).toFixed(1)}%）、1試合の手数 ${(mv / N).toFixed(1)}`
    + (cfg.party ? `、拾った箱 ${(pk / N).toFixed(1)}個・使ったアイテム ${(it / N).toFixed(1)}個（矢${used.arrow} いぬ${used.dog} 雨${used.rain} はと${used.dove}）` : ''));
}
