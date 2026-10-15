// 友人戦の部屋のルール。通信のことは何も知らない（worker.js から呼ぶ。node test.js でも試せる）
//   部屋 ：{id, phase, cfg, hand, seats, game, start, state, winners, wins, votes, listed}
//          listed：部屋の一覧に出すか（部屋を作った人が決める。ふだんは出す）
//          limit：1手の持ち時間（秒）。部屋を作った人が集まり中に決める
//          turnAt：今の番が始まった時刻、seen：{pid: 最後にいなくなった時刻}、left：この試合で退室扱いになった人の pid
//          miss：{pid: 続けて時間切れになった回数}、auto：{game, n} この手は時間切れで CPU が代わりに打つ
//          phase は 'lobby'（集まり中）/ 'playing'（対戦中）/ 'over'（決着）
//          seats は席0〜2。{pid, name, char} か null（あき席。始めたら CPU が入る）。席0が部屋を作った人
//          char はキャラ（0 マカロン / 1 キャンディ / 2 ゼリー / 3 プリン）。3人でかぶらない
//          chars は試合中の3席のキャラ（始めたときに、あき席には残りのキャラを入れる）
//          pid は各ブラウザが持つ秘密の番号。ほかの人には見せない
// 部屋を書きかえて、エラーなら文字列を返す（成功なら null か、配る情報）
import R from '../../rules.js';

export const CFG = { size: 6, need: 4, target: 3, loveBonus: true, maxMoves: R.MAXMOVES };
const HAND = R.handFor(CFG.size, CFG.need, 'auto');
export const CHARS = 4;
const okChar = (c) => Number.isInteger(c) && c >= 0 && c < CHARS;
// 席ごとのキャラ。人はその人のキャラ、あき席には使われていないキャラを若い順に
// キャラのない席（キャラえらびより前に作った部屋）や、かぶっている席にも、空いているキャラを入れる
export function fillChars(seats) {
  const used = new Set(), out = [];
  seats.forEach((s, i) => { if (s && okChar(s.char) && !used.has(s.char)) { out[i] = s.char; used.add(s.char); } });
  seats.forEach((s, i) => { if (out[i] === undefined) { let c = 0; while (used.has(c)) c++; used.add(c); out[i] = c; } });
  return out;
}
// 好きなキャラ（ほかの人が使っていれば、空いているキャラ）
function pickChar(room, want, except) {
  const used = new Set(room.seats.filter((s, i) => s && i !== except).map((s) => s.char));
  if (okChar(want) && !used.has(want)) return want;
  let c = 0; while (used.has(c)) c++; return c;
}
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8) || 'ゲスト';

export function newRoom(id, pid, name, char) {
  return { id, phase: 'lobby', cfg: CFG, hand: HAND, seats: [{ pid, name: cleanName(name), char: okChar(char) ? char : 0 }, null, null], chars: null,
    game: 0, start: 0, state: null, winners: [], wins: [0, 0, 0], votes: [], listed: true, limit: 60 };
}
export const seatOf = (room, pid) => room.seats.findIndex((s) => s && s.pid === pid);
const humans = (room) => room.seats.filter(Boolean);

// 席に座る（座っていれば名前を変えるだけ）。始まったあとなら、CPU の席を引きつぐ（途中から参加）
export function join(room, pid, name, char) {
  const i = seatOf(room, pid);
  if (i >= 0) { room.seats[i].name = cleanName(name); return null; }
  const k = room.seats.indexOf(null);
  if (k < 0) return '満員です';
  // 集まり中なら好きなキャラ、試合中なら交代するCPUのキャラのまま
  const c = room.phase === 'lobby' || !room.chars ? pickChar(room, char, k) : room.chars[k];
  room.seats[k] = { pid, name: cleanName(name), char: c };
  return null;
}
// キャラを変える（集まり中だけ。ほかの人が使っているキャラは選べない）
export function setChar(room, pid, char) {
  const i = seatOf(room, pid);
  if (i < 0) return '座っている人だけが選べます';
  if (room.phase !== 'lobby') return '試合が始まったら変えられません';
  if (!okChar(char)) return 'そのキャラはありません';
  if (room.seats.some((s, j) => s && j !== i && s.char === char)) return 'そのキャラはほかの人が使っています';
  room.seats[i].char = char;
  return null;
}

// 持ち時間（秒）。のんびり対局（持ち時間なし）は、通知と「3人組」ができるまで入れない（docs/ideas.md）
export const LIMITS = [30, 60, 90];
const AWAY_SEC = 15; // るす（回線が切れている）の人の番は、持ち時間を待たずにこの秒数で CPU が代わりに打つ
const limitOf = (room) => (room.limit ?? 60);
export function setLimit(room, pid, sec) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが決められます';
  if (room.phase !== 'lobby') return '試合が始まったら変えられません';
  if (!LIMITS.includes(sec)) return 'その持ち時間は選べません';
  room.limit = sec;
  return null;
}
// この手は時間切れで CPU が代わりに打つ手か
const isAuto = (room) => !!room.auto && room.auto.game === room.game && room.auto.n === room.state.moves;
// 今の番の締め切りの時刻。CPU の番・時間切れ後なら null。ms は1秒の長さ（手元で試すときだけ縮める）
export function deadline(room, online, ms = 1000) {
  if (room.phase !== 'playing' || !room.state || !limitOf(room)) return null;
  const seat = room.seats[room.state.turn];
  if (!seat || isAuto(room)) return null;
  const start = room.turnAt || 0, end = start + limitOf(room) * ms;
  if (online.has(seat.pid)) return end;
  return Math.min(end, Math.max(start, (room.seen || {})[seat.pid] || 0) + AWAY_SEC * ms);
}
// 時間切れ（座っている人のブラウザが、締め切りを過ぎたら知らせてくる）。その1手は CPU が打つ。2回続けたら退室扱い
export function timeout(room, pid, online, now, ms = 1000) {
  if (seatOf(room, pid) < 0) return '座っている人だけが知らせられます';
  const end = deadline(room, online, ms);
  if (end === null || now < end) return null; // まだ（時計のずれなど）。何もしない
  const p = room.state.turn, seat = room.seats[p], miss = room.miss ??= {};
  miss[seat.pid] = (miss[seat.pid] || 0) + 1;
  if (miss[seat.pid] >= 2) {
    miss[seat.pid] = 0; (room.left ??= []).push(seat.pid); room.seats[p] = null;
    return { p, name: seat.name, why: 'timeout2' };
  }
  room.auto = { game: room.game, n: room.state.moves };
  return { p, name: seat.name, why: 'timeout' };
}

function startGame(room) {
  room.game++;
  room.turnAt = Date.now(); room.left = [];
  room.state = R.newState(room.cfg, room.hand, room.start);
  room.chars = fillChars(room.seats);
  room.phase = 'playing'; room.winners = []; room.votes = [];
}
// 部屋を作った人だけが始められる。あき席は CPU になる
export function start(room, pid) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが始められます';
  if (room.phase !== 'lobby') return 'もう始まっています';
  startGame(room);
  return null;
}

const same = (x, a) => x.t === a.t && x.to === a.to && (x.from ?? null) === (a.from ?? null);
// 1手。n は「何手目か」（state.moves）で、ずれていたら受けつけない（二重送信やCPUの手の重なりよけ）
// 人の席はその人だけ、CPU の席と時間切れの手は座っている人なら誰でも（ブラウザが考えた手を送ってくる）打てる
export function act(room, pid, game, n, a) {
  if (room.phase !== 'playing' || game !== room.game) return '今は打てません';
  const st = room.state, p = st.turn, seat = room.seats[p];
  if (n !== st.moves) return '盤がずれています';
  const byCpu = !seat || (isAuto(room) && seat.pid !== pid);
  if (byCpu ? seatOf(room, pid) < 0 : seat.pid !== pid) return 'あなたの番ではありません';
  if (!a || typeof a !== 'object') return '手がおかしいです';
  const legal = R.actions(room.cfg, st, p).find((x) => same(x, a));
  if (!legal) return 'その手は打てません';
  const r = R.step(room.cfg, st, legal);
  room.state = r.state; room.turnAt = Date.now();
  if (!byCpu) (room.miss ??= {})[pid] = 0; // 自分で打てたら、時間切れの回数はリセット
  if (r.over) {
    room.phase = 'over'; room.winners = r.winners;
    if (r.winners.length === 1) room.wins[r.winners[0]]++;
  }
  return { game, n, p, a: { t: legal.t, from: legal.from ?? null, to: legal.to } };
}

// 部屋の一覧に出すかどうか（部屋を作った人だけ）
export function setListed(room, pid, on) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが決められます';
  room.listed = !!on;
  return null;
}

// 部屋の一覧にのせる情報。pid はのせない
export function summary(room, online) {
  return { id: room.id, phase: room.phase, listed: room.listed !== false, updated: Date.now(), chars: charsOf(room), limit: limitOf(room),
    seats: room.seats.map((s) => (s ? { name: s.name, online: online.has(s.pid) } : null)) };
}

// いなくなった時刻を覚える（るすの人の15秒をここから数える）
export function markSeen(room, pid, now) { (room.seen ??= {})[pid] = now; }

// 部屋を出る。席は CPU（集まり中なら、あき席）になる。部屋を作った人が集まり中に出たら、次の人が席0（部屋を作った人）になる
export function leave(room, pid) {
  const i = seatOf(room, pid);
  if (i < 0) return '座っていません';
  const name = room.seats[i].name;
  room.seats[i] = null;
  room.votes = room.votes.filter((v) => v !== pid);
  if (room.phase === 'lobby' && i === 0) {
    const k = room.seats.findIndex(Boolean);
    if (k > 0) { room.seats[0] = room.seats[k]; room.seats[k] = null; }
  }
  return { p: i, name, why: 'leave' };
}

// 「この3人でもう一回」。座っている人が全員押したら次の試合（先手は画面の「もう一回」と同じ決め方）
export function again(room, pid) {
  if (room.phase !== 'over') return '試合が終わってからです';
  if (seatOf(room, pid) < 0) return '座っている人だけが押せます';
  if (!room.votes.includes(pid)) room.votes.push(pid);
  if (humans(room).every((s) => room.votes.includes(s.pid))) {
    room.start = room.winners.length === 1 ? (room.winners[0] + 1) % 3 : (room.start + 1) % 3;
    startGame(room);
  }
  return null;
}

const charsOf = (room) => (room.phase === 'lobby' || !room.chars ? fillChars(room.seats) : room.chars);
// その人に見せる部屋の様子。pid はのせない。cpuDriver：CPU の手を考える係（いちばん若い席の、つながっている人）
export function view(room, pid, online, ms = 1000) {
  const seats = room.seats.map((s, i) => ({
    name: s ? s.name : null, empty: !s, cpu: !s && room.phase !== 'lobby',
    online: !!s && online.has(s.pid), voted: !!s && room.votes.includes(s.pid), host: i === 0,
  }));
  const driver = room.seats.findIndex((s) => s && online.has(s.pid));
  return { id: room.id, phase: room.phase, cfg: room.cfg, hand: room.hand, seats, you: seatOf(room, pid),
    game: room.game, state: room.state, winners: room.winners, wins: room.wins, cpuDriver: driver, listed: room.listed !== false, chars: charsOf(room),
    kicked: seatOf(room, pid) < 0 && (room.left || []).includes(pid),
    limit: limitOf(room), auto: room.phase === 'playing' && isAuto(room), secMs: ms,
    turnLeft: (() => { const end = deadline(room, online, ms); return end === null ? null : end - Date.now(); })() };
}
