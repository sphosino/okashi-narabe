// 動いているサーバーに2人でつないで、1試合を最後まで打ってみる：node try-live.js [http://127.0.0.1:8787]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CPU = require('../cpu.js');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const pid = () => Array.from({ length: 20 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

const res = await fetch(BASE + '/rooms', { method: 'POST', body: JSON.stringify({ pid: (globalThis.A = pid()), name: 'けんじ' }) });
const { id } = await res.json();
console.log('部屋', id);
const B = pid();
const players = [A, B].map((p, k) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/rooms/${id}/ws?pid=${p}`);
  const me = { ws, view: null, k };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'err') console.log(k, 'err', m.msg); me.view = m.room; me.onView?.(m); };
  return me;
});
await new Promise((r) => setTimeout(r, 800));
players[1].ws.send(JSON.stringify({ t: 'join', name: 'ともだち' }));
await new Promise((r) => setTimeout(r, 300));
console.log('席', players[0].view.seats.map((s) => s.name ?? 'あき').join(' / '), 'online', players[0].view.seats.map((s) => s.online));
players[0].ws.send(JSON.stringify({ t: 'start' }));

// 自分の番か、自分が CPU 係のときに打つ
let moves = 0;
const done = new Promise((resolve) => {
  for (const me of players) me.onView = (m) => {
    const v = me.view; if (m.move && me.k === 0) moves++;
    if (v.phase === 'over') { if (me.k === 0) resolve(v); return; }
    if (v.phase !== 'playing') return;
    const p = v.state.turn, seat = v.seats[p];
    if (p === v.you || (seat.cpu && v.cpuDriver === v.you)) {
      const a = CPU.choose(v.cfg, v.state, p, 'easy');
      me.ws.send(JSON.stringify({ t: 'act', game: v.game, n: v.state.moves, a }));
    }
  };
});
const v = await done;
console.log(`決着：${moves}手、勝ち ${v.winners.join(',')}、得点 ${v.state.scores.join('-')}`);
players.forEach((p) => p.ws.close());
