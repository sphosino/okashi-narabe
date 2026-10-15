// 部屋のルール（src/game.js）を、CPU同士で何試合も回して確かめる：node test.js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as G from './src/game.js';
const require = createRequire(import.meta.url);
const R = require('../rules.js'), CPU = require('../cpu.js');

const A = 'a'.repeat(16), B = 'b'.repeat(16), X = 'x'.repeat(16);
const on = new Set([A, B]);

// 集まる・始める
const room = G.newRoom('abcd2345', A, 'けんじ');
assert.equal(G.join(room, B, '<b>ともだち</b>とても長い名前'), null);
assert.equal(room.seats[1].name, 'bともだち/bと'); // < > を消して8文字まで
assert.equal(G.start(room, B), '部屋を作った人だけが始められます');
assert.equal(G.start(room, A), null);
assert.equal(G.join(room, X, 'あとから'), 'もう始まっています');
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
