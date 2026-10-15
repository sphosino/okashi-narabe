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

// 持ち時間：部屋を作った人が集まり中に選ぶ。時間切れの1手は CPU（座っている人が送る）。2回続けたら退室扱い。るすの人は15秒
{ const r = G.newRoom('tttt2345', A, 'a'); G.join(r, B, 'b');
  assert.equal(G.setLimit(r, B, 30), '部屋を作った人だけが決められます'); assert.equal(G.setLimit(r, A, 45), 'その持ち時間は選べません');
  assert.equal(G.setLimit(r, A, 30), null); G.start(r, A); r.state.turn = 1; r.turnAt = 0;
  const both = new Set([A, B]);
  assert.equal(G.deadline(r, both), 30000); assert.equal(G.deadline(r, new Set([A])), 15000, 'るすなら15秒');
  assert.equal(G.timeout(r, A, both, 29999), null, 'まだ');
  assert.deepEqual(G.timeout(r, A, both, 30000), { p: 1, name: 'b', why: 'timeout' });
  assert.equal(G.deadline(r, both), null, '時間切れのあとは締め切りなし');
  const a = CPU.choose(r.cfg, r.state, 1, 'easy');
  assert.equal(typeof G.act(r, A, r.game, r.state.moves, a), 'object', '時間切れの手は A のブラウザが CPU の手を送れる');
  r.state.turn = 1; r.turnAt = 0;
  assert.equal(typeof G.act(r, A, r.game, r.state.moves, CPU.choose(r.cfg, r.state, 1, 'easy')), 'string', '次の手は B だけ');
  assert.deepEqual(G.timeout(r, A, both, 30000), { p: 1, name: 'b', why: 'timeout2' }, '2回続けて時間切れ');
  assert.equal(r.seats[1], null); assert.equal(G.view(r, B, new Set([A])).kicked, true);
  assert.equal(G.join(r, B, 'b'), null); assert.equal(G.view(r, B, both).kicked, false);
  assert.equal(G.setLimit(G.newRoom('zzzz9999', A, 'a'), A, 0), 'その持ち時間は選べません'); }

// キャラえらびより前に作った部屋（席にキャラがない）でも、3人のキャラがかぶらない
{ const old = { ...G.newRoom('oooo2345', A, 'a'), phase: 'playing', chars: undefined };
  old.seats = [{ pid: A, name: 'a' }, { pid: B, name: 'b' }, { pid: X, name: 'x' }];
  assert.deepEqual(G.view(old, A, on).chars, [0, 1, 2]);
  old.seats[1].char = 3; assert.deepEqual(G.view(old, A, on).chars, [0, 3, 1]); }

// 部屋を出る：集まり中に部屋を作った人が出たら、次の人が部屋を作った人になる。試合中なら席は CPU に
{ const r = G.newRoom('llll2345', A, 'a'); G.join(r, B, 'b');
  assert.deepEqual(G.leave(r, A), { p: 0, name: 'a', why: 'leave' }); assert.equal(G.seatOf(r, B), 0); assert.equal(G.start(r, B), null);
  assert.equal(G.leave(r, X), '座っていません'); G.join(r, X, 'x');
  assert.deepEqual(G.leave(r, X), { p: 1, name: 'x', why: 'leave' }); assert.equal(r.seats[1], null); }

// ルール：部屋を作った人が集まり中に選ぶ。始めると、そのルールの盤と手持ち
{ const r = G.newRoom('uuuu2345', A, 'a'); G.join(r, B, 'b');
  assert.equal(G.setRule(r, B, 'deep'), '部屋を作った人だけが決められます'); assert.equal(G.setRule(r, A, 'xx'), 'そのルールはありません');
  assert.equal(G.setRule(r, A, 'deep'), null); assert.equal(G.view(r, A, on).rule, 'deep'); G.start(r, A);
  assert.equal(r.state.cells.length, 49); assert.deepEqual(r.state.hands, [6, 6, 6]);
  assert.equal(G.setRule(r, A, 'quick'), '試合が始まったら変えられません');
  const q = G.newRoom('vvvv2345', A, 'a'); G.setRule(q, A, 'quick'); G.start(q, A); assert.deepEqual(q.state.hands, [7, 7, 7]); assert.equal(q.cfg.target, 2); }

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
