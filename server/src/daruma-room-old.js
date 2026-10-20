// だるまさんがころんだの部屋（kind:'daruma'）。リアルタイム（ここだけ、ほかの部屋とちがって1手ずつではない）
//   席0がだるま（部屋を作った人）、席1〜3が子ども。通信の試作なので、強気度・気力・CPU の子どもはまだない
//
// 子どもの動き：押している間は加速、離すと減速（押しっぱなしで走る）。位置は「押した・離した時刻」だけから計算する
//   子どものブラウザは、押した瞬間に自分の画面で動かし、{t:'in', p:押した?, at:サーバーの時計での時刻} を送る
//   サーバーは at で並べ直して位置を計算する（遅れて届いても、押した時刻どおりに扱う＝巻き戻し）。ただし REWIND ミリ秒より昔は認めない
// 判定：だるまが言い終わって振り向いた時刻 T の GRACE ミリ秒後に動いていたらアウト。遅れて届く入力を待つため、判定は T+REWIND に行う
//   見ている間（T+GRACE〜T+WATCH）に押したらアウト。見終わったら「ひと休み」で、だるまが次を言い始めるまで子どもは動けない
// 時計：だるまが言っている間だけ進む。合わせて GOAL ミリ秒になったら、だるまの勝ち。子どもが1人でも TOUCH に届いたら子どもの勝ち
import { seatOf, markSeen, setListed, leave } from './game.js';
export { seatOf, markSeen, setListed, leave };

export const L = 100, TOUCH = 96, KNOCK = 35, GRACE = 150, REWIND = 250, WATCH = 1500, CUE = 800, GOAL = 40000;
export const RUN = { vmax: 10, acc: 30, dec: 40 }; // 単位/秒・単位/秒²（ひとりで遊ぶ試作の「A 押す」と同じ）
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8) || 'ゲスト';

// ---------- 子どもの動き（ブラウザでも同じ式を使う） ----------
export function advance(s, t) {
  const dt = (t - s.t) / 1000;
  if (dt <= 0) return s;
  let { x, v } = s;
  if (s.p) {
    const ta = Math.min(dt, Math.max(0, (RUN.vmax - v) / RUN.acc));
    x += v * ta + 0.5 * RUN.acc * ta * ta; v = Math.min(RUN.vmax, v + RUN.acc * ta); x += v * (dt - ta);
  } else {
    const td = Math.min(dt, v / RUN.dec);
    x += v * td - 0.5 * RUN.dec * td * td; v = Math.max(0, v - RUN.dec * td);
  }
  return { x: Math.min(L, x), v, p: s.p, t };
}
// 時刻 t の様子。base（基準の様子）から、t までの入力を順に当てる
export function stateAt(k, t) {
  let s = k.base;
  for (const e of k.ev) { if (e.at > t) break; s = { ...advance(s, e.at), p: e.p }; }
  return advance(s, t);
}
const still = (x, t) => ({ x, v: 0, p: false, t });

export function newRoom(id, pid, name) {
  return { kind: 'daruma', id, phase: 'lobby', seats: [{ pid, name: cleanName(name) }, null, null, null], listed: true,
    game: 0, kids: null, syl: 0, chantFrom: 0, chantTotal: 0, turnAt: 0, winner: null, wins: [0, 0], log: [] };
}
export function join(room, pid, name) {
  const i = seatOf(room, pid);
  if (i >= 0) { room.seats[i].name = cleanName(name); return null; }
  const k = room.seats.indexOf(null, 1);
  if (k < 0) return '満員です';
  room.seats[k] = { pid, name: cleanName(name) };
  if (room.kids) room.kids[k] = { base: still(0, Date.now()), ev: [], caught: 0 };
  return null;
}
export const setChar = () => 'だるまにはキャラがありません';
export const setRule = () => 'まだルールはありません';
export const setLimit = () => 'まだ持ち時間はありません';
export const timeout = () => null;

function startGame(room, now) {
  room.game++; room.phase = 'break'; room.syl = 0; room.chantTotal = 0; room.winner = null; room.log = [];
  room.kids = room.seats.map((s, i) => (i > 0 && s ? { base: still(0, now), ev: [], caught: 0 } : null));
}
export function start(room, pid) {
  if (seatOf(room, pid) !== 0) return 'だるま（部屋を作った人）だけが始められます';
  if (room.phase !== 'lobby' && room.phase !== 'over') return 'もう始まっています';
  if (!room.seats.slice(1).some(Boolean)) return '子どもが1人もいません';
  startGame(room, Date.now());
  return null;
}
export const again = start;

// 子どもたちの今の位置で、誰かがタッチしたか
function checkTouch(room, now) {
  if (room.phase === 'over' || !room.kids) return null;
  for (let i = 1; i < room.kids.length; i++) {
    const k = room.kids[i]; if (!k) continue;
    if (stateAt(k, now).x >= TOUCH) { room.phase = 'over'; room.winner = 'kids'; room.wins[1]++; room.log.push({ at: now, touch: i }); return i; }
  }
  return null;
}
// 子どもを止めて、新しい基準にする（ひと休みに入るとき・捕まったとき）
function freeze(k, t, dx = 0) { const s = stateAt(k, t); k.base = still(Math.max(0, s.x - dx), t); k.ev = []; }

// ---------- メッセージ（worker.js の Room から呼ばれる） ----------
// api：{ now(), save(), broadcast(extra), later(ms, fn) }。戻り値：本人に返すエラーの文字列か null
export function onMessage(api, room, pid, msg) {
  const now = api.now(), me = seatOf(room, pid);
  if (msg.t === 'sync') return { reply: { t: 'sync', c: msg.c, s: now } }; // 時計合わせ
  if (msg.t === 'in') { // 子どもの入力：押した・離した
    if (me < 1 || !room.kids || !room.kids[me]) return null;
    const k = room.kids[me]; if (k.caught > now) return null;
    let at = Number(msg.at); if (!Number.isFinite(at)) return null;
    at = Math.max(now - REWIND, Math.min(now, at)); // 巻き戻せるのは REWIND まで
    const p = !!msg.p;
    if (room.phase === 'chant') {
      if (at < k.base.t) at = k.base.t;
      k.ev.push({ at, p }); k.ev.sort((a, b) => a.at - b.at);
    } else if (room.phase === 'watch') {
      if (at < room.turnAt + GRACE) { k.ev.push({ at, p }); k.ev.sort((a, b) => a.at - b.at); } // 振り向く前の入力（遅れて届いた）
      else if (p) { catchKid(room, me, at); } // 見ている間に動いた
    } else return null; // ひと休み中などは動けない
    if (checkTouch(room, now)) { api.save(); api.broadcast({ event: { touch: me } }); return null; }
    api.save(); api.broadcast();
    return null;
  }
  if (msg.t === 'go') { // だるま：言い始める（合図のあと CUE ミリ秒で1音目）
    if (me !== 0 || room.phase !== 'break') return 'いまは言い始められません';
    room.phase = 'cue'; room.syl = 0; room.cueAt = now;
    api.save(); api.broadcast({ event: { cue: now + CUE } });
    api.later(CUE, () => {
      if (room.phase !== 'cue') return;
      room.phase = 'chant'; room.chantFrom = api.now();
      room.kids.forEach((k) => { if (k) freeze(k, room.chantFrom); });
      api.save(); api.broadcast({ event: { chant: room.chantFrom } });
    });
    return null;
  }
  if (msg.t === 'syl') { // だるま：1音言った。10音目は turn（振り向く）か見送るか
    if (me !== 0 || room.phase !== 'chant') return null;
    const i = Math.max(1, Math.min(10, msg.i | 0));
    room.syl = i;
    if (checkTouch(room, now)) { api.save(); api.broadcast({ event: { touch: true } }); return null; }
    if (i < 10) { api.broadcast({ event: { syl: i } }); return null; }
    room.chantTotal += now - room.chantFrom;
    if (room.chantTotal >= GOAL) { room.phase = 'over'; room.winner = 'daruma'; room.wins[0]++; api.save(); api.broadcast({ event: { timeup: true } }); return null; }
    if (!msg.turn) { // 見送り：子どもはそのまま動ける。すぐ次を言える
      room.syl = 0; room.chantFrom = now; room.log.push({ at: now, skip: true });
      api.save(); api.broadcast({ event: { skip: now } }); return null;
    }
    room.phase = 'watch'; room.turnAt = now;
    api.save(); api.broadcast({ event: { turn: now } });
    // 遅れて届く入力を待ってから、振り向いた時刻で判定する
    api.later(REWIND, () => {
      if (room.phase !== 'watch' || room.turnAt !== now) return;
      const T = room.turnAt + GRACE, caught = [];
      room.kids.forEach((k, i) => { if (k && k.caught <= T && stateAt(k, T).v > 0.05) { caught.push({ i, v: +stateAt(k, T).v.toFixed(2) }); catchKid(room, i, T); } });
      room.log.push({ at: room.turnAt, turn: true, caught: caught.map((c) => c.i) });
      api.save(); api.broadcast({ event: { judged: caught } });
    });
    api.later(WATCH, () => {
      if (room.phase !== 'watch' || room.turnAt !== now) return;
      room.phase = 'break'; room.syl = 0;
      room.kids.forEach((k) => { if (k) freeze(k, api.now()); });
      api.save(); api.broadcast({ event: { rest: true } });
    });
    return null;
  }
  return undefined; // ここでは扱わない（join・start・leave などは worker.js のふつうの流れで）
}
function catchKid(room, i, t) {
  const k = room.kids[i]; if (!k || k.caught > t) return;
  freeze(k, t, KNOCK); k.caught = t + 800;
}

export function summary(room, online) {
  return { kind: 'daruma', id: room.id, phase: room.phase, listed: room.listed !== false, updated: Date.now(),
    seats: room.seats.map((s) => (s ? { name: s.name, online: online.has(s.pid) } : null)) };
}
export function view(room, pid, online) {
  return { kind: 'daruma', id: room.id, phase: room.phase, you: seatOf(room, pid), game: room.game,
    seats: room.seats.map((s, i) => ({ name: s ? s.name : null, empty: !s, online: !!s && online.has(s.pid), host: i === 0 })),
    kids: room.kids, syl: room.syl, chantTotal: room.chantTotal, chantFrom: room.phase === 'chant' ? room.chantFrom : 0,
    turnAt: room.turnAt, winner: room.winner, wins: room.wins, listed: room.listed !== false,
    rule: { L, TOUCH, KNOCK, GRACE, REWIND, WATCH, CUE, GOAL, RUN } };
}
