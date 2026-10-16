// 動いているサーバーに2人でつないで、三人将棋を1局最後まで指してみる（あき席の緑は CPU。CPU 担当のブラウザのかわりに、でたらめな手を送る）
//   node shogi-live.js [http://127.0.0.1:8787]
import * as S from './src/shogi.js';
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const pid = () => Array.from({ length: 20 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) { console.log('NG', msg); process.exit(1); } console.log('ok', msg); };

const A = pid(), B = pid();
const { id } = await (await fetch(BASE + '/rooms', { method: 'POST', body: JSON.stringify({ pid: A, name: 'けんじ', kind: 'shogi3' }) })).json();
console.log('部屋', id);
const errs = [];
const players = [A, B].map((p, k) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/rooms/${id}/ws?pid=${p}`);
  const me = { ws, view: null, k, send: (o) => ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'err') errs.push(m.msg); if (m.room) me.view = m.room; };
  return me;
});
await sleep(800);
players[1].send({ t: 'join', name: 'ゆう' });
players[0].send({ t: 'rule', rule: 'next' });
players[0].send({ t: 'limit', sec: 30 });
await sleep(400);
const v0 = players[0].view;
check(v0.kind === 'shogi3' && v0.seats[1].name === 'ゆう' && v0.rule === 'next' && v0.limit === 30, '部屋を作って、2人目が座り、ルールと持ち時間を決めた');
const list = await (await fetch(BASE + '/rooms?kind=shogi3')).json(), listOk = await (await fetch(BASE + '/rooms')).json();
check(list.rooms.some((r) => r.id === id) && !listOk.rooms.some((r) => r.id === id), '部屋の一覧：三人将棋の一覧にだけ出る');
players[1].send({ t: 'start' });
await sleep(300);
check(errs.pop() === '部屋を作った人だけが始められます', '部屋を作った人でないと始められない');
players[0].send({ t: 'start' });
await sleep(400);
check(players[0].view.phase === 'playing' && players[0].view.seats[2].cpu && players[0].view.cpuDriver === 0, '始まった。緑は CPU で、CPU 担当は青（席0）');

// 1手目：赤が青の番に指そうとする → だめ。ありえない手 → だめ
const g = players[0].view.game;
players[1].send({ t: 'act', game: g, n: 0, a: { fr: 2, fc: 0, tr: 3, tc: 0, pro: false } });
await sleep(300);
check(errs.pop() === 'あなたの番ではありません', 'ほかの人の番には指せない');
players[0].send({ t: 'act', game: g, n: 0, a: { fr: 8, fc: 2, tr: 3, tc: 2, pro: false } });
await sleep(300);
check(errs.pop() === 'その手は指せません', 'ルールにない手ははねる');

// あとは最後まで：番の人（緑なら CPU 担当の青）が、でたらめな手を送る。100手で赤が投了
let resigned = false;
for (let i = 0; i < 2000; i++) {
  const v = players[0].view;
  if (v.phase !== 'playing') break;
  const st = v.state, p = st.turn;
  if (!resigned && st.moves >= 100 && !st.elim[1]) { players[1].send({ t: 'resign', game: v.game }); resigned = true; await sleep(250); continue; }
  const who = p === 2 ? players[0] : players[p];
  const ms = S.legalMoves(st, p), caps = ms.filter((m) => !m.drop && st.board[m.tr][m.tc]);
  const mv = caps.length && Math.random() < 0.6 ? caps[Math.floor(Math.random() * caps.length)] : ms[Math.floor(Math.random() * ms.length)];
  who.send({ t: 'act', game: v.game, n: st.moves, a: mv });
  const n = st.moves; let w = 0;
  while (players[0].view.state.moves === n && players[0].view.phase === 'playing' && w < 40) { await sleep(25); w++; }
}
const end = players[0].view, end1 = players[1].view;
check(end.phase === 'over' && JSON.stringify(end.state) === JSON.stringify(end1.state), `決着（${['青', '赤', '緑'][end.state.winner]}の勝ち・${end.state.winType}・${end.state.moves}手）。2人とも同じ盤`);
check(!resigned || end.state.log.some((x) => x.resign && x.o === 1), '投了が棋譜に残る');
check(end.ranking.length === 3 && end.ranking[0] === end.state.winner, `順位 ${end.ranking.map((i) => ['青', '赤', '緑'][i]).join('→')}`);
console.log('のこったエラー', errs);

players[0].send({ t: 'again' }); await sleep(300);
check(players[0].view.phase === 'over', '1人だけ「もう一局」ではまだ始まらない');
players[1].send({ t: 'again' }); await sleep(400);
check(players[0].view.phase === 'playing' && players[0].view.state.moves === 0 && players[0].view.game === g + 1, '2人とも押したら次の対局');
players.forEach((p) => p.ws.close());
process.exit(0);
