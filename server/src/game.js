// 友人戦の部屋のルール。通信のことは何も知らない（worker.js から呼ぶ。node test.js でも試せる）
//   部屋 ：{id, phase, cfg, hand, seats, game, start, state, winners, wins, votes, listed}
//          listed：部屋の一覧に出すか（部屋を作った人が決める。ふだんは出す）
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
export function fillChars(seats) {
  const used = new Set(seats.filter(Boolean).map((s) => s.char));
  return seats.map((s) => { if (s) return s.char; let c = 0; while (used.has(c)) c++; used.add(c); return c; });
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
    game: 0, start: 0, state: null, winners: [], wins: [0, 0, 0], votes: [], listed: true };
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

function startGame(room) {
  room.game++;
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
// 人の席はその人だけ、CPU の席は座っている人なら誰でも（ブラウザが考えた手を送ってくる）打てる
export function act(room, pid, game, n, a) {
  if (room.phase !== 'playing' || game !== room.game) return '今は打てません';
  const st = room.state, p = st.turn, seat = room.seats[p];
  if (n !== st.moves) return '盤がずれています';
  if (seat ? seat.pid !== pid : seatOf(room, pid) < 0) return 'あなたの番ではありません';
  if (!a || typeof a !== 'object') return '手がおかしいです';
  const legal = R.actions(room.cfg, st, p).find((x) => same(x, a));
  if (!legal) return 'その手は打てません';
  const r = R.step(room.cfg, st, legal);
  room.state = r.state;
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
  return { id: room.id, phase: room.phase, listed: room.listed !== false, updated: Date.now(), chars: charsOf(room),
    seats: room.seats.map((s) => (s ? { name: s.name, online: online.has(s.pid) } : null)) };
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

const charsOf = (room) => (room.phase === 'lobby' || !room.chars ? fillChars(room.seats.map((s) => s && { char: s.char ?? 0 })) : room.chars);
// その人に見せる部屋の様子。pid はのせない。cpuDriver：CPU の手を考える係（いちばん若い席の、つながっている人）
export function view(room, pid, online) {
  const seats = room.seats.map((s, i) => ({
    name: s ? s.name : null, empty: !s, cpu: !s && room.phase !== 'lobby',
    online: !!s && online.has(s.pid), voted: !!s && room.votes.includes(s.pid), host: i === 0,
  }));
  const driver = room.seats.findIndex((s) => s && online.has(s.pid));
  return { id: room.id, phase: room.phase, cfg: room.cfg, hand: room.hand, seats, you: seatOf(room, pid),
    game: room.game, state: room.state, winners: room.winners, wins: room.wins, cpuDriver: driver, listed: room.listed !== false, chars: charsOf(room) };
}
