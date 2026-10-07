// おかしならべ（6×6・4つ並べ・手持ち5・目標3点・入れかえ何回でも・入れかえたお菓子は入れかえ禁止）を高速に回す
const SIZE=6,NEED=4,HAND=6,TARGET=3,MAXMOVES=150;
const N=SIZE;
const DIR8=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const NB=[...Array(N*N)].map((_,i)=>{const r=Math.floor(i/N),c=i%N,o=[];for(const[dr,dc]of DIR8){const rr=r+dr,cc=c+dc;if(rr>=0&&rr<N&&cc>=0&&cc<N)o.push(rr*N+cc)}return o});
const WIN=[];for(let r=0;r<N;r++)for(let c=0;c<N;c++)for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){const er=r+dr*(NEED-1),ec=c+dc*(NEED-1);if(er<0||er>=N||ec<0||ec>=N)continue;const w=[];for(let s=0;s<NEED;s++)w.push((r+dr*s)*N+c+dc*s);WIN.push(w)}
const lines=c=>{const o=[];for(const w of WIN){const p=c[w[0]];if(p!==null&&w.every(j=>c[j]===p))o.push({p,w})}return o};
function actions(S,p){const o=[];if(S.hands[p]>0)S.cells.forEach((v,i)=>{if(v===null)o.push({t:'place',to:i})});
  S.cells.forEach((v,i)=>{if(v!==p)return;for(const j of NB[i]){const u=S.cells[j];if(u===null)o.push({t:'move',from:i,to:j});else if(u!==p&&!S.fixed.has(i)&&!S.fixed.has(j))o.push({t:'swap',from:i,to:j})}});return o}
function simulate(S,a,p){const c=S.cells.slice();if(a.t==='place')c[a.to]=p;else if(a.t==='move'){c[a.to]=p;c[a.from]=null}else{const o=c[a.to];c[a.to]=p;c[a.from]=o}return c}
function threats(c,q,hands){let t=0;for(const w of WIN){let own=0,e=-1,ne=0;for(const j of w){if(c[j]===q)own++;else if(c[j]===null){ne++;e=j}}
  if(own===NEED-1&&ne===1&&(hands[q]>0||NB[e].some(j=>c[j]===q&&!w.includes(j))))t++}return t}
// threats2：入れかえで揃う形も数える。最後の1マスに他人のお菓子があり、それが固定されておらず、
// qがそのとなりに（並びの外で、固定されていない）お菓子を持っていれば、入れかえで揃えられる
function threats2(c,q,hands,fixed){let t=0;for(const w of WIN){let own=0,e=-1,ne=0,g=-1;for(const j of w){if(c[j]===q)own++;else if(c[j]===null){ne++;e=j}else g=j}
  if(own!==NEED-1)continue;
  if(ne===1){if(hands[q]>0||NB[e].some(j=>c[j]===q&&!w.includes(j)))t++}
  else if(!fixed.has(g)&&NB[g].some(j=>c[j]===q&&!w.includes(j)&&!fixed.has(j)))t++}return t}
function fixedAfter(S,a,eaten){const f=new Set(S.fixed);
  if(a.t==='move'&&f.has(a.from)){f.delete(a.from);f.add(a.to)}
  if(a.t==='swap')f.add(a.to);
  eaten.forEach(i=>f.delete(i));return f}
function buildup(c,q){let t=0;for(const w of WIN){let own=0,ne=0;for(const j of w){if(c[j]===q)own++;else if(c[j]===null)ne++}if(own===NEED-2&&ne===2)t++}return t}

// ---- プレイヤーの頭の中 ----
// smartOld：入れかえで揃う形を見落としていた前のCPU
function evalSmart(S,a,p){const c=simulate(S,a,p),ls=lines(c);let s=0;const hands=S.hands.slice();if(a.t==='place')hands[p]--;
  for(const l of ls)s+=l.p===p?(S.scores[p]+1>=TARGET?10000:120):-90;
  const after=c.slice();ls.forEach(l=>l.w.forEach(i=>{if(after[i]!==null){hands[after[i]]++;after[i]=null}}));
  s+=threats(after,p,hands)*14+buildup(after,p)*3-buildup(after,(p+1)%3)*1.5;
  const nx=(p+1)%3,nx2=(p+2)%3;
  s-=threats(after,nx,hands)*(S.scores[nx]+1>=TARGET?60:22);
  s-=threats(after,nx2,hands)*(S.scores[nx2]+1>=TARGET?40:14);
  if(a.t==='swap'&&!ls.some(l=>l.p===p))s-=3;if(a.t==='place')s+=2;
  const mid=(N-1)/2;s-=(Math.abs(Math.floor(a.to/N)-mid)+Math.abs(a.to%N-mid))*.6;return s+Math.random()*4}
// smart：ゲーム内のCPU。smartOldに加えて、入れかえで揃う「あと1つ」も見る
function evalSmart2(S,a,p){const c=simulate(S,a,p),ls=lines(c);let s=0;const hands=S.hands.slice();if(a.t==='place')hands[p]--;
  for(const l of ls)s+=l.p===p?(S.scores[p]+1>=TARGET?10000:120):-90;
  const after=c.slice(),eaten=[];ls.forEach(l=>l.w.forEach(i=>{if(after[i]!==null){hands[after[i]]++;after[i]=null;eaten.push(i)}}));
  const fx=fixedAfter(S,a,eaten);
  s+=threats2(after,p,hands,fx)*14+buildup(after,p)*3-buildup(after,(p+1)%3)*1.5;
  const nx=(p+1)%3,nx2=(p+2)%3;
  s-=threats2(after,nx,hands,fx)*(S.scores[nx]+1>=TARGET?60:22);
  s-=threats2(after,nx2,hands,fx)*(S.scores[nx2]+1>=TARGET?40:14);
  if(a.t==='swap'&&!ls.some(l=>l.p===p))s-=3;if(a.t==='place')s+=2;
  const mid=(N-1)/2;s-=(Math.abs(Math.floor(a.to/N)-mid)+Math.abs(a.to%N-mid))*.6;return s+Math.random()*4}
// greedy：揃えられるなら揃える。それ以外は適当（守りも先読みもしない）
function evalGreedy(S,a,p){const ls=lines(simulate(S,a,p));let s=0;for(const l of ls)s+=l.p===p?100:-100;return s+Math.random()*10}
// random：完全に適当
const evalRandom=()=>Math.random();
// casual（素人）：目の前だけ見る。揃える／相手の「あと1つ」のマスをふさぐ／自分の「あと1つ」を増やす／自分のお菓子の近くに置く
function openSpots(c,q){const s=new Set();for(const w of WIN){let own=0,e=-1,ne=0;for(const j of w){if(c[j]===q)own++;else if(c[j]===null){ne++;e=j}}if(own===NEED-1&&ne===1)s.add(e)}return s}
function evalCasual(S,a,p){
  const c=simulate(S,a,p),ls=lines(c);let s=0;
  for(const l of ls)s+=l.p===p?100:-100;
  for(const q of[(p+1)%3,(p+2)%3])if(openSpots(S.cells,q).has(a.to))s+=30; // ふさぐ
  s+=openSpots(c,p).size*10;
  s+=NB[a.to].filter(j=>c[j]===p).length*2;
  return s+Math.random()*3}
const BRAINS={smart:evalSmart2,smartOld:evalSmart,greedy:evalGreedy,random:evalRandom,casual:evalCasual};

function play(seats){ // seats: 3人の頭（席順＝手番順、0番が先手）
  const S={cells:Array(N*N).fill(null),hands:[HAND,HAND,HAND],scores:[0,0,0],fixed:new Set(),turn:0,moves:0};
  while(true){
    if(S.moves>=MAXMOVES)break;
    let acts=actions(S,S.turn),k=0;
    while(!acts.length&&k<3){S.turn=(S.turn+1)%3;acts=actions(S,S.turn);k++}
    if(!acts.length)break;
    const p=S.turn,f=BRAINS[seats[p]];let best=acts[0],bs=-Infinity;for(const a of acts){const v=f(S,a,p);if(v>bs){bs=v;best=a}}
    S.cells=simulate(S,best,p);if(best.t==='place')S.hands[p]--;
    if(best.t==='move'&&S.fixed.has(best.from)){S.fixed.delete(best.from);S.fixed.add(best.to)}
    if(best.t==='swap'){S.fixed.add(best.to)}
    S.moves++;
    const ls=lines(S.cells);
    if(ls.length){const eaten=new Set(ls.flatMap(l=>l.w));ls.forEach(l=>S.scores[l.p]=Math.min(TARGET,S.scores[l.p]+1));
      eaten.forEach(i=>{S.hands[S.cells[i]]++;S.cells[i]=null;S.fixed.delete(i)});
      const w=[0,1,2].filter(q=>S.scores[q]>=TARGET);if(w.length)return{winners:w.length>1&&w.includes(p)?[p]:w,moves:S.moves,timeout:false}}
    S.turn=(S.turn+1)%3;
  }
  const m=Math.max(...S.scores);return{winners:[0,1,2].filter(q=>S.scores[q]===m),moves:S.moves,timeout:true};
}

// 実験：調べたい頭を1人、相手2人。席は3通り順番に回して公平にする
function trial(hero,foe,games){
  let win=0,share=0,moves=0,to=0;
  for(let g=0;g<games;g++){const seat=g%3,seats=[foe,foe,foe];seats[seat]=hero;
    const r=play(seats);moves+=r.moves;if(r.timeout)to++;
    if(r.winners.includes(seat)){share+=1/r.winners.length;if(r.winners.length===1)win++}}
  return{hero,foe,games,winRate:(share/games*100).toFixed(1)+'%',avgMoves:(moves/games).toFixed(0),timeouts:to};
}
function seatTest(brain,games){
  const share=[0,0,0];for(let g=0;g<games;g++){const r=play([brain,brain,brain]);r.winners.forEach(w=>share[w]+=1/r.winners.length)}
  return share.map(s=>(s/games*100).toFixed(1)+'%');
}
const G=+process.argv[2]||300;
console.log(JSON.stringify(trial('smart','casual',G)));
console.log(JSON.stringify(trial('casual','smart',G)));
console.log(JSON.stringify(trial('casual','greedy',G)));
console.log(JSON.stringify(trial('casual','random',G)));
// 素人2人＋smart1人の別の見方：smartが1位になれなかった試合で誰が勝ったか、は不要。1対1の混戦も見る
function mixed(games){const share={smart:0,casual:0,greedy:0};for(let g=0;g<games;g++){const order=[['smart','casual','greedy'],['casual','greedy','smart'],['greedy','smart','casual'],['smart','greedy','casual'],['greedy','casual','smart'],['casual','smart','greedy']][g%6];
  const r=play(order);r.winners.forEach(w=>share[order[w]]+=1/r.winners.length)}for(const k in share)share[k]=(share[k]/games*100).toFixed(1)+'%';return share}
console.log('三つ巴 smart/casual/greedy:',JSON.stringify(mixed(G)));
