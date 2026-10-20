// だるまさんがころんだの部屋（kind:'daruma'、2026-10-20 に作り直し）
//   ひとりで遊ぶ版（Desktop/daruma の index.html）と同じ決まり rules.js を、サーバーが 0.1 秒ずつ進める。
//   みんなの画面は、サーバーから届く様子を描くだけ（全員に同じことが起きる。ずるができない）
//   席0がだるま、席1〜4が子ども。人がいない席には CPU が入る（だるまの席が空いていれば CPU のだるま）
//   決まりのファイルは ./daruma/ に写してある（元は sphosino/daruma の rules.js と old/daruma-core.js。変えたら sync-daruma.sh で写し直す）
import { seatOf, markSeen, setListed } from './game.js';
import R from './daruma/rules.cjs';
export { seatOf, markSeen, setListed };

const Core = R.Core, P = R.P;
// 遊び方の数字（ひとりで遊ぶ版の最初の値と同じ）
const CLOCK_S = 46, KNOCK = 25, GRACE_TICKS = 3, LOOK_TICKS = 12, CUE_MS = 800, PUSH_MS = 1100, BREAK_MS = [1000, 3500];
const SEATS = 5;
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8) || 'ゲスト';
// 動いているものはメモリにだけ持つ（関数やタイマーは保存できないので）
const LIVE = new WeakMap();
const live = (room) => { let L = LIVE.get(room); if (!L) LIVE.set(room, (L = { cpu: null, loop: null, timer: null, ev: [] })); return L; };

export function newRoom(id, pid, name) {
  const seats = Array(SEATS).fill(null);
  seats[0] = { pid, name: cleanName(name) };   // 作った人は、まずだるまの席（あとで子どもの席に移れる）
  return { kind: 'daruma', id, phase: 'lobby', host: pid, seats, listed: true, game: 0, st: null, want: Array(SEATS).fill(0), winner: null, wins: [0, 0] };
}
export function join(room, pid, name) {
  const i = seatOf(room, pid);
  if (i >= 0) { room.seats[i].name = cleanName(name); return null; }
  if (room.phase !== 'lobby' && room.phase !== 'over') return 'もう始まっています。終わるまで待ってね';
  let k = room.seats.indexOf(null, 1); if (k < 0) k = room.seats[0] ? -1 : 0;
  if (k < 0) return '満員です';
  room.seats[k] = { pid, name: cleanName(name) };
  return null;
}
// 席を移る（始まる前だけ）。0 ならだるま、1〜4 なら子ども
function moveSeat(room, pid, to) {
  const i = seatOf(room, pid);
  if (i < 0) return 'まだ部屋に入っていません';
  if (room.phase !== 'lobby' && room.phase !== 'over') return 'いまは席を移れません';
  to = to | 0; if (to < 0 || to >= SEATS) return 'その席はありません';
  if (room.seats[to]) return 'その席にはもう人がいます';
  room.seats[to] = room.seats[i]; room.seats[i] = null; return null;
}
export function leave(room, pid) {
  const i = seatOf(room, pid); if (i < 0) return '部屋に入っていません';
  if (room.phase !== 'lobby' && room.phase !== 'over') { // 遊んでいる途中：その席は CPU にまかせる
    room.seats[i] = null; const c = room.st && kidOf(room, i); if (c) { c.human = false; c.input = 0; }
    return { seat: i };
  }
  room.seats[i] = null;
  if (room.host === pid) room.host = (room.seats.find(Boolean) || {}).pid || null;
  return { seat: i };
}
export const setChar = () => 'だるまにはキャラがありません';
export const setRule = () => 'まだルールはありません';
export const setLimit = () => 'まだ持ち時間はありません';
export const timeout = () => null;
const kidOf = (room, seat) => room.st && room.st.children.find((c) => c.id === 'h' + (seat - 1));

export function start(room, pid) {
  if (room.host !== pid) return '部屋を作った人だけが始められます';
  if (room.phase !== 'lobby' && room.phase !== 'over') return 'もう始まっています';
  room._startNow = true; return null;   // 実際に始めるのは onStart（タイマーが使えるところ）
}
export const again = start;

// ---------- 進める ----------
function setup(room) {
  P.GOAL_TICKS = CLOCK_S * 10; P.CATCH_KNOCK = KNOCK; R.LOOK.grace = GRACE_TICKS; R.LOOK.ticks = LOOK_TICKS;
}
function begin(api, room) {
  setup(room);
  const L = live(room); stopAll(L);
  room.game++; room.winner = null; room.want = Array(SEATS).fill(0);
  room.st = R.newGameSeats({ kids: room.seats.slice(1).map((s) => (s ? { name: s.name } : null)) });
  L.cpu = room.seats[0] ? null : R.cpuDaruma();
  toPrep(api, room, true);
}
function stopAll(L) { if (L.loop) clearInterval(L.loop); if (L.timer) clearTimeout(L.timer); L.loop = L.timer = null; }
function event(room, e) { live(room).ev.push(e); }
function after(api, room, ms, fn) { const L = live(room); if (L.timer) clearTimeout(L.timer); L.timer = setTimeout(() => { L.timer = null; try { fn(); } catch (e) { console.error(e); } }, ms); }
function toPrep(api, room, first) {
  const st = room.st, L = live(room);
  room.phase = 'prep'; R.applyReserved(st);
  if (L.cpu) { L.cpu.onPrep(st); const b = first ? 1500 : BREAK_MS[0] + Math.random() * (BREAK_MS[1] - BREAK_MS[0]); after(api, room, Math.max(0, b - CUE_MS), () => toCue(api, room)); }
  else st.turnArmed = true;
  api.save(); send(api, room);
}
function toCue(api, room) {
  if (room.phase !== 'prep') return;
  room.phase = 'cue'; event(room, { cue: 1 }); send(api, room);
  after(api, room, CUE_MS, () => toChant(api, room));
}
function toChant(api, room) {
  room.phase = 'chant'; send(api, room);
  const L = live(room); if (L.loop) clearInterval(L.loop);
  L.loop = setInterval(() => { try { step(api, room); } catch (e) { console.error(e); } }, P.TICK_MS);
}
function step(api, room) {
  setup(room);
  const st = room.st, L = live(room);
  for (const c of st.children) if (c.human) c.input = room.want[(+c.id.slice(1)) + 1] || 0;
  if (room.phase === 'chant') {
    const before = R.said(st), res = Core.tick(P, st);
    if (st.justOutOfGas) { st.justOutOfGas = false; event(room, { outOfGas: 1 }); }
    if (R.said(st) > before && R.said(st) < 10) event(room, { syl: R.said(st) });
    if (res.reached) return finish(api, room, res.reached);
    if (res.timeUp) return finish(api, room, null);
    if (res.chantDone) {
      event(room, { syl: 10 });
      if (R.wantsTurn(st)) { R.startLook(st); room.phase = 'look'; event(room, { look: 1 }); }
      else {
        const out = R.resolve(st);
        event(room, { carry: 1, auto: !!out.autoSkip });
        if (L.cpu) L.cpu.onCarry(st); else st.turnArmed = false;
      }
    } else if (L.cpu) L.cpu.onTick(st);
  } else if (room.phase === 'look') {
    const r = R.lookTick(st);
    if (r.reached) return finish(api, room, r.reached);
    for (const c of r.newly) event(room, { caught: c.id, late: +(c.caughtLate * 0.1).toFixed(2), pressing: !!c.caughtPressing });
    if (r.done) {
      const out = R.endLook(st);
      event(room, { pushed: out.caughtList.map((c) => c.id), from: out.before });
      room.phase = 'push'; clearInterval(L.loop); L.loop = null;
      after(api, room, PUSH_MS, () => toPrep(api, room, false));
    }
  }
  send(api, room);
}
function finish(api, room, kid) {
  const L = live(room); stopAll(L);
  room.phase = 'over';
  room.winner = kid ? { side: 'kids', id: kid.id, name: kid.name } : { side: 'daruma' };
  room.wins[kid ? 1 : 0]++;
  event(room, { over: 1 });
  api.save(); send(api, room);
}
function send(api, room) { const L = live(room), ev = L.ev; L.ev = []; api.broadcast(ev.length ? { ev } : undefined); }

// ---------- メッセージ（worker.js の Room から呼ばれる） ----------
// api：{ now(), save(), broadcast(extra), later(ms, fn) }。戻り値：{reply} か、本人に返すエラーの文字列か、null（扱った）か、undefined（ふつうの流れへ）
export function onMessage(api, room, pid, msg) {
  const me = seatOf(room, pid), st = room.st, playing = st && !['lobby', 'over'].includes(room.phase);
  if (msg.t === 'sync') return { reply: { t: 'sync', c: msg.c, s: api.now() } };
  if (msg.t === 'seat') { const e = moveSeat(room, pid, msg.i); if (e) return e; api.save(); api.broadcast(); return null; }
  if (msg.t === 'want') { // 子ども：目標の速さ（0〜1、0 は離している）
    if (me < 1 || !playing) return null;
    room.want[me] = Math.max(0, Math.min(1, +msg.v || 0)); return null;
  }
  if (me === 0 && playing) { // だるま
    if (msg.t === 'go') { if (room.phase !== 'prep') return 'いまは唱えられません'; toCue(api, room); return null; }
    if (msg.t === 'arm') { st.turnArmed = !!msg.on; send(api, room); return null; }
    if (msg.t === 'aura') {
      const r = String(msg.r); if (!R.TIERS.includes(r)) return null;
      if (room.phase === 'prep') st.reward = r; else st.nextReward = (r === st.reward || r === st.nextReward) ? null : r;
      send(api, room); return null;
    }
    if (msg.t === 'tempo') {
      const v = Math.max(0, Math.min(100, +msg.v || 0));
      if (room.phase === 'chant') Core.applyTempoChange(P, st, v); else st.tempoValue = v;
      send(api, room); return null;
    }
  }
  if (msg.t === 'start' || msg.t === 'again') { // 始める：ここで始めると、タイマーを使える
    const e = start(room, pid); if (e) return e;
    room._startNow = false; begin(api, room); return null;
  }
  return undefined; // join・leave・listed などは worker.js のふつうの流れで
}

export function summary(room, online) {
  return { kind: 'daruma', id: room.id, phase: room.phase, listed: room.listed !== false, updated: Date.now(),
    seats: room.seats.map((s) => (s ? { name: s.name, online: online.has(s.pid) } : null)) };
}
// それぞれ向けの様子。だるまの「振り向くつもりか」と「予約したオーラ」は、だるまにしか見せない
export function view(room, pid, online) {
  const you = seatOf(room, pid), st = room.st;
  const v = { kind: 'daruma', id: room.id, phase: room.phase, you, host: room.host === pid, game: room.game,
    seats: room.seats.map((s, i) => ({ name: s ? s.name : null, empty: !s, online: !!s && online.has(s.pid) })),
    winner: room.winner, wins: room.wins, listed: room.listed !== false, rule: { clock: CLOCK_S, knock: KNOCK } };
  if (st) {
    v.st = { cp: st.chantProgress, el: st.elapsedTicks, goal: CLOCK_S * 10, stamina: st.stamina, staminaMax: st.staminaMax, reward: st.reward,
      tempo: st.tempoValue, cycle: st.cycle, catches: st.catches, type: st.typeName,
      look: st.looking && st.look ? { t: st.look.t, from: st.look.from } : null,
      kids: st.children.map((c) => ({ id: c.id, name: c.name, human: !!c.human, pos: c.pos, vel: c.vel, maxSpeed: c.maxSpeed, brake: c.brake,
        energy: c.energy, energyMax: c.energyMax, winded: !!c.winded, caught: !!c.caughtNow, accT: c.accT })) };
    if (you === 0) { v.st.turnArmed = st.turnArmed; v.st.nextReward = st.nextReward; }
  }
  return v;
}
