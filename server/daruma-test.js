// だるまの部屋の決まり（src/daruma-room.js）を、時計を自由に進めて試す：node daruma-test.js
//   いちばん見たいのは「遅れて届いた入力を、押した時刻どおりに扱えるか（巻き戻し）」
import * as D from './src/daruma-room.js';

let clock = 1_000_000;
const tasks = [];
const sent = [];
const api = {
  now: () => clock,
  save: () => {},
  broadcast: (extra) => { if (extra) sent.push(extra.event); },
  later: (ms, fn) => tasks.push({ at: clock + ms, fn }),
};
function run(ms) { // 時計を ms 進めて、その間のタイマーを動かす
  const end = clock + ms;
  for (;;) {
    tasks.sort((a, b) => a.at - b.at);
    const t = tasks[0];
    if (!t || t.at > end) break;
    tasks.shift(); clock = t.at; t.fn();
  }
  clock = end;
}
const ok = (c, m) => { console.log(c ? 'ok' : 'NG', m); if (!c) process.exitCode = 1; };
const send = (pid, msg) => D.onMessage(api, room, pid, msg);

const room = D.newRoom('test', 'darumaPID', 'だるま');
D.join(room, 'kidA', 'あ'); D.join(room, 'kidB', 'い');
ok(D.start(room, 'darumaPID') === null && room.phase === 'break', '始めるとひと休みから');
send('darumaPID', { t: 'go' }); run(D.CUE + 1);
ok(room.phase === 'chant', '合図のあと言い始める');

// 子どもA：2秒走って、だるまが振り向く 0.3秒前に離す。ただし「離した」が届くのは振り向いた 0.2秒後（遅れ）
// 子どもB：振り向いたあとも走り続けている
const t0 = clock;
send('kidA', { t: 'in', p: true, at: t0 }); send('kidB', { t: 'in', p: true, at: t0 });
for (let i = 1; i <= 9; i++) { run(200); send('darumaPID', { t: 'syl', i }); }
run(200);
const T = clock;
send('darumaPID', { t: 'syl', i: 10, turn: true });
ok(room.phase === 'watch', '10音目で振り向く');
run(50); // 届くまで 0.2秒かかった（振り向く 0.15秒前に離して、届いたのは振り向いた 0.05秒後）
send('kidA', { t: 'in', p: false, at: T - 150 });
run(D.REWIND);
const judged = sent.find((e) => e && e.judged);
ok(judged && !judged.judged.some((c) => c.i === 1), `0.2秒遅れて届いても、振り向く前に離した子どもA はセーフ（離してから止まるまで ${(D.RUN.vmax / D.RUN.dec).toFixed(2)}秒）`);
ok(judged && judged.judged.some((c) => c.i === 2), '走り続けた子どもB はアウト');
const xB = D.stateAt(room.kids[2], clock).x;
ok(Math.abs(xB - Math.max(0, D.stateAt({ base: room.kids[2].base, ev: [] }, clock).x)) < 1e-9 && room.kids[2].ev.length === 0, `アウトの子どもB は止められて ${D.KNOCK} 下がった（今 ${xB.toFixed(1)}）`);

// 巻き戻しの上限：0.25秒より昔の「離した」は認めない
run(D.WATCH);
ok(room.phase === 'break', '見終わったらひと休み');
send('kidA', { t: 'in', p: true, at: clock });
ok(D.stateAt(room.kids[1], clock + 1000).v === 0, 'ひと休み中は押しても動かない');
send('darumaPID', { t: 'go' }); run(D.CUE + 1);
const t1 = clock;
send('kidA', { t: 'in', p: true, at: t1 });
run(1000);
send('kidA', { t: 'in', p: false, at: clock - 900 }); // 0.9秒前に離したと言いはる
const e = room.kids[1].ev.at(-1);
ok(clock - e.at <= D.REWIND, `0.9秒前と言っても、${D.REWIND}ミリ秒前までしか巻き戻さない（${clock - e.at}ミリ秒前として扱う）`);

// 見送り：子どもはそのまま動ける
for (let i = 1; i <= 9; i++) { run(150); send('darumaPID', { t: 'syl', i }); }
send('darumaPID', { t: 'syl', i: 10, turn: false });
ok(room.phase === 'chant', '見送ったら、ひと休みなしで続けて言える');

// タッチ：子どもB を走らせ続けて、だるまに届いたら子どもの勝ち
send('kidB', { t: 'in', p: true, at: clock });
for (let n = 0; n < 40 && room.phase !== 'over'; n++) { run(300); send('darumaPID', { t: 'syl', i: 1 + (n % 9) }); }
ok(room.phase === 'over' && room.winner === 'kids', `子どもがタッチして、子どもの勝ち（${room.log.at(-1)?.touch}番の席）`);

// 時計：言っている時間が 40秒 たまったら、だるまの勝ち
const r2 = D.newRoom('t2', 'd', 'だるま'); D.join(r2, 'k', 'こ'); D.start(r2, 'd');
const s2 = (m) => D.onMessage(api, r2, 'd', m);
let rounds = 0;
while (r2.phase !== 'over' && rounds < 50) {
  s2({ t: 'go' }); run(D.CUE + 1);
  for (let i = 1; i <= 9; i++) { run(300); s2({ t: 'syl', i }); }
  run(300); s2({ t: 'syl', i: 10, turn: true }); run(D.WATCH + 10); rounds++;
}
ok(r2.winner === 'daruma', `だるまが言っている時間だけで40秒（${rounds}回言った・ひと休みや振り向きは数えない）`);
