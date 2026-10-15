// 部屋のルール（src/game.js）を、CPU同士で何試合も回して確かめる：node test.js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from './src/game.js';
const require = createRequire(import.meta.url);
const R = require('../rules.js'), CPU = require('../cpu.js');

const A = 'a'.repeat(16), B = 'b'.repeat(16), X = 'x'.repeat(16);
const on = new Set([A, B]);

// キャラ：好きなキャラを選べて、かぶったら空いているキャラ。始めたら、あき席に残りのキャラ
{ const r = G.newRoom('cccc2345', A, 'a', 3);
  assert.equal(G.join(r, B, 'b', 3), null); assert.equal(r.seats[1].char, 0);
  assert.equal(G.setChar(r, B, 3), 'そのキャラはほかの人が使っています');
  assert.equal(G.setChar(r, B, 1), null);
  assert.deepEqual(G.view(r, A, on).chars, [3, 1, 0]);
  G.start(r, A); assert.deepEqual(r.chars, [3, 1, 0]);
  assert.equal(G.setChar(r, B, 2), '試合が始まったら変えられません');
  const X2 = 'y'.repeat(16); r.seats[2] = null; assert.equal(G.join(r, X2, 'x', 2), null); assert.equal(r.seats[2].char, 0); }

// 退室扱い：番の人が3分るすで、ほかの人が待っているときだけ。戻ってきたら CPU の席に入りなおせる
{ const r = G.newRoom('kkkk2345', A, 'a'); G.join(r, B, 'b'); G.start(r, A);
  r.state.turn = 1; r.turnAt = 0; G.markSeen(r, B, 0);
  assert.equal(G.kickAway(r, A, new Set([A, B]), G.KICK_MS * 2), null, 'いる人は退室にしない');
  assert.equal(G.kickAway(r, X, new Set([X]), G.KICK_MS * 2), null, '座っていない人は頼めない');
  assert.equal(G.kickAway(r, A, new Set([A]), G.KICK_MS - 1), null, '3分たっていない');
  assert.deepEqual(G.kickAway(r, A, new Set([A]), G.KICK_MS), { kicked: 1, name: 'b' });
  assert.equal(r.seats[1], null); assert.equal(G.view(r, B, new Set([A])).kicked, true);
  assert.equal(G.join(r, B, 'b'), null); assert.equal(G.seatOf(r, B), 1); assert.equal(G.view(r, B, new Set([A, B])).kicked, false); }

// 集まる・始める
const room = G.newRoom('abcd2345', A, 'けんじ');
assert.equal(G.join(room, B, '<b>ともだち</b>とても長い名前'), null);
assert.equal(room.seats[1].name, 'bともだち/bと'); // < > を消して8文字まで
assert.equal(G.start(room, B), '部屋を作った人だけが始められます');
assert.equal(G.start(room, A), null);
// 途中から参加：CPU の席を引きつぐ。満員なら入れない
{ const r2 = G.newRoom('zzzz2345', A, 'a'); G.start(r2, A);
  assert.equal(G.join(r2, X, 'あとから'), null); assert.equal(G.seatOf(r2, X), 1);
  assert.equal(G.join(r2, B, 'もうひとり'), null); assert.equal(G.join(r2, 'c'.repeat(16), 'さらに'), '満員です');
  assert.equal(G.view(r2, A, on).seats[1].cpu, false); }
let v = G.view(room, B, on);
assert.equal(v.you, 1); assert.equal(v.seats[2].cpu, true); assert.equal(v.cpuDriver, 0);
assert.ok(!JSON.stringify(v).includes(A), 'pid を見せない');

// ずれた手・番でない人の手・ルール違反は受けつけない
const p0 = room.state.turn;
const pidOf = (p) => (room.seats[p] ? room.seats[p].pid : A);
const other = pidOf((p0 + 1) % 3) === pidOf(p0) ? X : pidOf((p0 + 1) % 3);
assert.equal(typeof G.act(room, pidOf(p0), room.game, 5, { t: 'place', to: 0 }), 'string');
assert.equal(typeof G.act(room, other, room.game, 0, { t: 'place', to: 0 }), 'string');
assert.equal(typeof G.act(room, pidOf(p0), room.game, 0, { t: 'move', from: 0, to: 1 }), 'string');

// 何試合も回す：部屋の結果が、rules.js をそのまま回した結果と一致するか
let games = 0;
for (let k = 0; k < 30; k++) {
  if (room.phase === 'over') { assert.equal(G.again(room, A), null); assert.equal(room.phase, 'over'); assert.equal(G.again(room, B), null); }
  assert.equal(room.phase, 'playing');
  let st = R.newState(room.cfg, room.hand, room.start);
  assert.deepEqual(room.state, st);
  while (room.phase === 'playing') {
    const p = room.state.turn, a = CPU.choose(room.cfg, room.state, p, 'easy');
    const res = G.act(room, pidOf(p), room.game, room.state.moves, a);
    assert.equal(typeof res, 'object', res);
    const r = R.step(room.cfg, st, a); st = r.state;
    assert.deepEqual(room.state, st);
    if (r.over) assert.deepEqual(room.winners, r.winners);
  }
  games++;
}
console.log(`ok：${games}試合、勝ち数 ${room.wins.join('/')}`);
