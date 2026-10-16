// サーバーの三人将棋のルール（src/shogi.js）が、ブラウザ版（../../shogi3 の game.js など）と同じに動くかを確かめる
//   node shogi-check.js [局数]
// でたらめに指した対局で、1手ごとに「指せる手の一覧」「指したあとの盤・持ち駒・脱落・番・勝ち」をくらべる
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './src/shogi.js';

const SHOGI3 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shogi3');
const ctx = vm.createContext({ console, Math, JSON, Map, Set, Array, Object, Number, String, performance: { now: () => 0 } });
vm.runInContext('var renderKifu=()=>{},setStatus=()=>{},render=()=>{};var CanvasRenderingContext2D=function(){};CanvasRenderingContext2D.prototype.roundRect=1;', ctx);
for (const f of ['constants.js', 'attack-maps.js', 'ai.js', 'game.js']) vm.runInContext(fs.readFileSync(path.join(SHOGI3, f), 'utf8'), ctx, { filename: f });
const B = (code) => vm.runInContext(code, ctx);
B('setStatus=()=>{};render=()=>{};');
// ui.js の nextTurn と同じ：次の生きている人へ。指せる手がなければとばす
B('function nextTurnSim(){for(let i=0;i<3;i++){const n=nextAliveOn(eliminated,turn);if(n<0)return;turn=n;if(allMoves(turn,board).length)return;}}');

const key = (m) => (m.drop ? `d${m.piece}${m.tr}${m.tc}` : `${m.fr}${m.fc}${m.tr}${m.tc}${m.pro ? '+' : ''}`);
const RULE_JS = { all: "'all'", next: "'next'", off: 'false' };
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const games = Number(process.argv[2]) || 60;
const tally = { king: 0, try: 0, limit: 0 };
let plies = 0, resigns = 0;
for (let g = 0; g < games; g++) {
  const rule = S.RULES[g % 3];
  let st = S.newState(rule);
  ctx.__s = st;
  B(`board=JSON.parse(JSON.stringify(__s.board));hand=JSON.parse(JSON.stringify(__s.hand));eliminated=[false,false,false];turn=0;moveCount=0;
     gover=false;winner=-1;winType='normal';kifu=[];gameRecord=null;humanPlayer=-1;keepAllPieces=${RULE_JS[rule]};lastMove=null;`);
  while (!st.over) {
    const o = st.turn;
    const mine = S.legalMoves(st, o), theirs = B(`allMoves(turn,board)`);
    const a = mine.map(key).sort().join(','), b = theirs.map(key).sort().join(',');
    if (a !== b || B('turn') !== o) throw new Error(`局${g} ${st.moves}手目：指せる手がちがう（番 ${o} / ${B('turn')}）`);
    // ときどき投了（局の終わりのほうで）。それ以外は、取る手を多めに選ぶ
    if (st.moves > 60 && rnd() < 0.004) {
      st = S.resign(st, o); resigns++;
      B(`(function(p){for(let r=0;r<9;r++)for(let c=0;c<9;c++){const x=board[r][c];if(x&&x.o===p&&x.p==='OU')board[r][c]=null;}
         eliminated[p]=true;const alive=[0,1,2].filter(i=>!eliminated[i]);if(alive.length<=1){gover=true;winner=alive[0];}else if(turn===p)nextTurnSim();})(${o})`);
    } else {
      // 指し方は3とおり：取る手が多め（玉取りで終わりやすい）/ 玉が前へ（入玉）/ 玉は取らない（500手まで）
      const mode = g % 5 < 3 ? 'cap' : g % 5 === 3 ? 'try' : 'quiet';
      const pick = (l) => l[Math.floor(rnd() * l.length)];
      const caps = mine.filter((m) => !m.drop && st.board[m.tr][m.tc]);
      const fwd = (m) => !m.drop && st.board[m.fr][m.fc].p === 'OU' && (o === 0 ? m.tr < m.fr : o === 1 ? m.tr > m.fr : m.tc < m.fc);
      const quiet = mine.filter((m) => m.drop || st.board[m.tr][m.tc]?.p !== 'OU');
      const mv = mode === 'cap' ? (caps.length && rnd() < 0.5 ? pick(caps) : pick(mine))
        : mode === 'try' ? (mine.some(fwd) && rnd() < 0.7 ? pick(mine.filter(fwd)) : pick(quiet.length ? quiet : mine))
        : pick(quiet.length ? quiet : mine);
      st = S.play(st, o, S.findMove(st, o, JSON.parse(JSON.stringify(mv))));
      ctx.__m = mv;
      B(`applyMove(__m,turn); if(!gover) nextTurnSim();`);
    }
    plies++;
    const bs = B(`JSON.stringify({board,hand,eliminated,gover,winner:gover?winner:-1,turn:gover?-1:turn})`);
    const ss = JSON.stringify({ board: st.board, hand: st.hand, eliminated: st.elim, gover: st.over, winner: st.over ? st.winner : -1, turn: st.over ? -1 : st.turn });
    if (bs !== ss) throw new Error(`局${g} ${st.moves}手目：指したあとの様子がちがう\nブラウザ ${bs}\nサーバー ${ss}`);
  }
  const wt = B('winType');
  const want = { king: 'normal', try: 'trywin', limit: 'limit' }[st.winType];
  if (wt !== want && !(st.winType === 'king' && st.log.at(-1)?.resign)) throw new Error(`局${g}：勝ち方がちがう ${st.winType} / ${wt}`);
  tally[st.winType]++;
}
console.log(`OK ${games}局・${plies}手で同じ（玉取り ${tally.king}・入玉 ${tally.try}・500手 ${tally.limit}・投了 ${resigns}）`);
