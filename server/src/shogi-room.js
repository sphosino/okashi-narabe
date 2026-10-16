// 三人将棋の部屋のルール。通信のことは何も知らない（worker.js から呼ぶ。node shogi-test.js でも試せる）
//   部屋：{kind:'shogi3', id, phase, seats, game, state, winners, wins, votes, listed, limit, rule, turnAt, seen, left, miss, auto}
//     席0 青・席1 赤・席2 緑。席は {pid, name, char} か null（あき席。始めたら CPU が入る）。席0が部屋を作った人
//     state は shogi.js の局面。rule は取った駒のゆくえ（all / next / off）。limit は1手の持ち時間（秒）
//   席に座る・時間切れ・部屋を出る・一覧に出すかは、おかしならべ（game.js）と同じしくみを使う
// 部屋を書きかえて、エラーなら文字列を返す（成功なら null か、配る情報）
import * as S from './shogi.js';
import { seatOf, join, timeout, deadline, markSeen, setListed, leave } from './game.js';
export { seatOf, join, timeout, markSeen, setListed, leave };

export const LIMITS = [30, 60, 180];
const limitOf = (room) => room.limit ?? 60;
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8) || 'ゲスト';
const humans = (room) => room.seats.filter(Boolean);

export function newRoom(id, pid, name) {
  return { kind: 'shogi3', id, phase: 'lobby', seats: [{ pid, name: cleanName(name), char: 0 }, null, null], chars: null,
    game: 0, state: null, winners: [], wins: [0, 0, 0], votes: [], listed: true, limit: 60, rule: 'all' };
}
export function setRule(room, pid, rule) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが決められます';
  if (room.phase !== 'lobby') return '対局が始まったら変えられません';
  if (!S.RULES.includes(rule)) return 'そのルールはありません';
  room.rule = rule;
  return null;
}
export function setLimit(room, pid, sec) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが決められます';
  if (room.phase !== 'lobby') return '対局が始まったら変えられません';
  if (!LIMITS.includes(sec)) return 'その持ち時間は選べません';
  room.limit = sec;
  return null;
}
export const setChar = () => '三人将棋にはキャラがありません';

function startGame(room) {
  room.game++;
  room.turnAt = Date.now(); room.left = []; room.miss = {}; room.auto = null;
  room.state = S.newState(room.rule);
  room.phase = 'playing'; room.winners = []; room.votes = [];
}
// 部屋を作った人だけが始められる。あき席は CPU になる
export function start(room, pid) {
  if (seatOf(room, pid) !== 0) return '部屋を作った人だけが始められます';
  if (room.phase !== 'lobby') return 'もう始まっています';
  startGame(room);
  return null;
}

const isAuto = (room) => !!room.auto && room.auto.game === room.game && room.auto.n === room.state.moves;
function finish(room) {
  if (!room.state.over) return;
  room.phase = 'over'; room.winners = room.state.winner >= 0 ? [room.state.winner] : [];
  if (room.winners.length === 1) room.wins[room.winners[0]]++;
}
// 1手。n は「何手目か」（state.moves）で、ずれていたら受けつけない（二重送信やCPUの手の重なりよけ）
// 人の席はその人だけ、CPU の席と時間切れの手は座っている人なら誰でも（ブラウザが考えた手を送ってくる）指せる
export function act(room, pid, game, n, mv) {
  if (room.phase !== 'playing' || game !== room.game) return '今は指せません';
  const st = room.state, p = st.turn, seat = room.seats[p];
  if (n !== st.moves) return '盤がずれています';
  const byCpu = !seat || (isAuto(room) && seat.pid !== pid);
  if (byCpu ? seatOf(room, pid) < 0 : seat.pid !== pid) return 'あなたの番ではありません';
  const legal = S.findMove(st, p, mv);
  if (!legal) return 'その手は指せません';
  room.state = S.play(st, p, legal);
  room.turnAt = Date.now();
  if (!byCpu) room.miss[pid] = 0; // 自分で指せたら、時間切れの回数はリセット
  finish(room);
  return { game, n, p, mv: legal };
}
// 投了。自分の席だけ（番でなくてもよい）。脱落して、残りの2人で続ける
export function resign(room, pid, game) {
  if (room.phase !== 'playing' || game !== room.game) return '今は投了できません';
  const p = seatOf(room, pid);
  if (p < 0) return '座っている人だけが投了できます';
  if (room.state.elim[p]) return 'もう脱落しています';
  const wasTurn = room.state.turn;
  room.state = S.resign(room.state, p);
  if (room.state.turn !== wasTurn) room.turnAt = Date.now();
  finish(room);
  return { game, p, resign: true };
}

// 「もう一局」。座っている人が全員押したら次の対局
export function again(room, pid) {
  if (room.phase !== 'over') return '対局が終わってからです';
  if (seatOf(room, pid) < 0) return '座っている人だけが押せます';
  if (!room.votes.includes(pid)) room.votes.push(pid);
  if (humans(room).every((s) => room.votes.includes(s.pid))) startGame(room);
  return null;
}

// 部屋の一覧にのせる情報。pid はのせない
export function summary(room, online) {
  return { kind: 'shogi3', id: room.id, phase: room.phase, listed: room.listed !== false, updated: Date.now(), limit: limitOf(room), rule: room.rule,
    seats: room.seats.map((s) => (s ? { name: s.name, online: online.has(s.pid) } : null)) };
}
// その人に見せる部屋の様子。pid はのせない。cpuDriver：CPU の手を考える係（いちばん若い席の、つながっている人）
export function view(room, pid, online, ms = 1000) {
  const seats = room.seats.map((s, i) => ({
    name: s ? s.name : null, empty: !s, cpu: !s && room.phase !== 'lobby',
    online: !!s && online.has(s.pid), voted: !!s && room.votes.includes(s.pid), host: i === 0,
  }));
  const end = deadline(room, online, ms);
  return { kind: 'shogi3', id: room.id, phase: room.phase, seats, you: seatOf(room, pid),
    game: room.game, state: room.state, winners: room.winners, wins: room.wins,
    ranking: room.state ? S.ranking(room.state) : null,
    cpuDriver: room.seats.findIndex((s) => s && online.has(s.pid)), listed: room.listed !== false,
    kicked: seatOf(room, pid) < 0 && (room.left || []).includes(pid),
    limit: limitOf(room), rule: room.rule, auto: room.phase === 'playing' && isAuto(room), secMs: ms,
    turnLeft: end === null ? null : end - Date.now() };
}
