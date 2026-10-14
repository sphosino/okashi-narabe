// 恋ボーナスの実験。CPUは全員ゲーム内の「ふつう」と同じ考え方で、ボーナスを知っている（aware）かどうかを切りかえる
//   M     ：恋モードの自分のお菓子を動かして（入れかえ含む）揃えたら +1点（ゲームに入れたルール）
//   1,2,3 ：並びに自分の恋モードのお菓子がT個以上入っていたら +1点（ボツ案。知っていても勝率が上がらない）
//   0     ：ボーナスなし
// 使い方: node tools/love-bonus-test.js <試合数> [0,M,1,2,3]
const SIZE=6,NEED=4,HAND=6,TARGET=3,MAXMOVES=150;
const N=SIZE;
const DIR8=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const NB=[...Array(N*N)].map((_,i)=>{const r=Math.floor(i/N),c=i%N,o=[];for(const[dr,dc]of DIR8){const rr=r+dr,cc=c+dc;if(rr>=0&&rr<N&&cc>=0&&cc<N)o.push(rr*N+cc)}return o});
const WIN=[];for(let r=0;r<N;r++)for(let c=0;c<N;c++)for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){const er=r+dr*(NEED-1),ec=c+dc*(NEED-1);if(er<0||er>=N||ec<0||ec>=N)continue;const w=[];for(let s=0;s<NEED;s++)w.push((r+dr*s)*N+c+dc*s);WIN.push(w)}
const lines=c=>{const o=[];for(const w of WIN){const p=c[w[0]];if(p!==null&&w.every(j=>c[j]===p))o.push({p,w})}return o};
function actions(S,p){const o=[];if(S.hands[p]>0)S.cells.forEach((v,i)=>{if(v===null)o.push({t:'place',to:i})});
  S.cells.forEach((v,i)=>{if(v!==p)return;for(const j of NB[i]){const u=S.cells[j];if(u===null)o.push({t:'move',from:i,to:j});else if(u!==p&&S.fixed.has(i)===S.fixed.has(j))o.push({t:'swap',from:i,to:j})}});return o}
function simulate(S,a,p){const c=S.cells.slice();if(a.t==='place')c[a.to]=p;else if(a.t==='move'){c[a.to]=p;c[a.from]=null}else{const o=c[a.to];c[a.to]=p;c[a.from]=o}return c}
function fixedAfter(S,a){const f=new Set(S.fixed);
  if(a.t==='move'&&f.has(a.from)){f.delete(a.from);f.add(a.to)}
  if(a.t==='swap'){if(f.has(a.from)&&f.has(a.to))f.delete(a.from);else f.add(a.from)}
  return f}
// 並びの点：1点＋（恋モードがT個以上なら+1）
// T==='M'：恋モードのお菓子を動かして（入れかえ含む）揃えたら、そのお菓子を含む並びが+1
const lineGain=(w,fixed,T,mv)=>T==='M'?1+(mv&&w.includes(mv.to)?1:0):1+(T>0&&w.filter(i=>fixed.has(i)).length>=T?1:0);
const loveMover=(S,a)=>a.t!=='place'&&S.fixed.has(a.from)?a:null;

// 次の一手で揃う「あと1つ」。aware なら、ボーナス付きになりそうな並びは2倍に数える
function threats(c,q,hands,fixed,T,aware){let t=0;for(const w of WIN){let own=0,e=-1,ne=0,g=-1,love=0;for(const j of w){if(c[j]===q){own++;if(fixed.has(j))love++}else if(c[j]===null){ne++;e=j}else g=j}
  if(own!==NEED-1)continue;
  if(T==='M'){const bon=aware?2:1;
    if(ne===1){if(NB[e].some(j=>c[j]===q&&!w.includes(j)&&fixed.has(j)))t+=bon;else if(hands[q]>0||NB[e].some(j=>c[j]===q&&!w.includes(j)))t+=1}
    else if(fixed.has(g)&&NB[g].some(j=>c[j]===q&&!w.includes(j)&&fixed.has(j)))t+=bon;
    else if(NB[g].some(j=>c[j]===q&&!w.includes(j)&&fixed.has(j)===fixed.has(g)))t+=1;continue}
  const v=aware&&T>0&&love>=T?2:1;
  if(ne===1){if(hands[q]>0||NB[e].some(j=>c[j]===q&&!w.includes(j)))t+=v}
  else if(NB[g].some(j=>c[j]===q&&!w.includes(j)&&fixed.has(j)===fixed.has(g)))t+=v}return t}
function buildup(c,q,fixed,T,aware){let t=0;for(const w of WIN){let own=0,ne=0,love=0;for(const j of w){if(c[j]===q){own++;if(fixed.has(j))love++}else if(c[j]===null)ne++}
  if(own===NEED-2&&ne===2)t+=aware&&T!=='M'&&T>0&&love>=Math.max(1,T-1)?1.6:1}return t}

// ゲーム内の「ふつう」と同じ考え方。aware=true ならボーナスを知っている
function evalSmart(S,a,p,T,aware){
  const c=simulate(S,a,p),fx0=fixedAfter(S,a),ls=lines(c);let s=0;const hands=S.hands.slice();if(a.t==='place')hands[p]--;
  const gain=[0,0,0];const mv=loveMover(S,a);for(const l of ls)gain[l.p]+=aware?lineGain(l.w,fx0,T,l.p===p?mv:null):1;
  if(gain[p])s+=S.scores[p]+gain[p]>=TARGET?10000:120*gain[p];
  for(const q of[0,1,2])if(q!==p&&gain[q])s-=90*gain[q];
  const after=c.slice(),fx=new Set(fx0);ls.forEach(l=>l.w.forEach(i=>{if(after[i]!==null){hands[after[i]]++;after[i]=null}fx.delete(i)}));
  s+=threats(after,p,hands,fx,T,aware)*14+buildup(after,p,fx,T,aware)*3-buildup(after,(p+1)%3,fx,T,aware)*1.5;
  const nx=(p+1)%3,nx2=(p+2)%3;
  const near=q=>S.scores[q]+(aware&&T?2:1)>=TARGET; // ボーナス込みで届きそうか
  s-=threats(after,nx,hands,fx,T,aware)*(near(nx)?60:22);
  s-=threats(after,nx2,hands,fx,T,aware)*(near(nx2)?40:14);
  if(a.t==='swap'&&!ls.some(l=>l.p===p))s-=3;if(a.t==='place')s+=2;
  // 相手に恋モードを渡す入れかえは、そのお菓子の仲間が近くにいるほど嫌う
  if(aware&&T>0&&T!=='M'&&a.t==='swap'&&!S.fixed.has(a.from)&&!S.fixed.has(a.to)){const q=S.cells[a.to];s-=3+2*NB[a.from].filter(j=>c[j]===q).length}
  const mid=(N-1)/2;s-=(Math.abs(Math.floor(a.to/N)-mid)+Math.abs(a.to%N-mid))*.6;return s+Math.random()*4}

function play(seats,T){ // seats: 各席が aware かどうか
  const S={cells:Array(N*N).fill(null),hands:[HAND,HAND,HAND],scores:[0,0,0],fixed:new Set(),turn:0,moves:0};
  const st={swap:0,move:0,acts:0,lines:0,bonus:0,leader:null};
  const done=w=>Object.assign(st,{winners:w,moves:S.moves});
  while(true){
    if(S.moves>=MAXMOVES)break;
    let acts=actions(S,S.turn),k=0;
    while(!acts.length&&k<3){S.turn=(S.turn+1)%3;acts=actions(S,S.turn);k++}
    if(!acts.length)break;
    const p=S.turn;let best=acts[0],bs=-Infinity;for(const a of acts){const v=evalSmart(S,a,p,T,seats[p]);if(v>bs){bs=v;best=a}}
    st.acts++;if(best.t==='swap')st.swap++;if(best.t==='move')st.move++;
    const mv=loveMover(S,best);S.cells=simulate(S,best,p);if(best.t==='place')S.hands[p]--;S.fixed=fixedAfter(S,best);
    S.moves++;
    const ls=lines(S.cells);
    if(ls.length){const gain=[0,0,0];ls.forEach(l=>{const g=lineGain(l.w,S.fixed,T,l.p===p?mv:null);gain[l.p]+=g;st.lines++;if(g>1)st.bonus++});
      const eaten=new Set(ls.flatMap(l=>l.w));[0,1,2].forEach(q=>S.scores[q]=Math.min(TARGET,S.scores[q]+gain[q]));
      eaten.forEach(i=>{S.hands[S.cells[i]]++;S.cells[i]=null;S.fixed.delete(i)});
      if(st.leader===null){const top=Math.max(...S.scores),ld=[0,1,2].filter(q=>S.scores[q]===top);if(top>=2&&ld.length===1)st.leader=ld[0]}
      const w=[0,1,2].filter(q=>S.scores[q]>=TARGET);if(w.length)return done(w.length>1&&w.includes(p)?[p]:w)}
    S.turn=(S.turn+1)%3;
  }
  const m=Math.max(...S.scores);st.timeout=true;return done([0,1,2].filter(q=>S.scores[q]===m));
}

const pct=x=>(x*100).toFixed(1)+'%';
const med=a=>a.slice().sort((x,y)=>x-y)[a.length>>1];
// 全員同じ考え方で回したときの試合の形
function shape(T,G){let mo=0,sw=0,ac=0,ln=0,bo=0,dr=0,lead=0,leadWon=0;const seat=[0,0,0],mv=[];
  for(let g=0;g<G;g++){const r=play([true,true,true],T);sw+=r.swap;mo+=r.move;ac+=r.acts;ln+=r.lines;bo+=r.bonus;mv.push(r.moves);
    if(r.winners.length>1)dr++;else seat[r.winners[0]]++;
    if(r.leader!==null){lead++;if(r.winners.length===1&&r.winners[0]===r.leader)leadWon++}}
  return{T:T||'なし',手数中央値:med(mv),入れかえ:pct(sw/ac),動かす:pct(mo/ac),ボーナス並び:pct(bo/Math.max(ln,1)),引き分け:pct(dr/G),
    席の勝率:seat.map(s=>pct(s/G)).join('/'),先に2点の人の勝率:pct(leadWon/Math.max(lead,1))}}
// ボーナスを知っている1人 対 知らない2人（席は回す）。33%より上なら「知っていると得」
function edge(T,G){let share=0;for(let g=0;g<G;g++){const seat=g%3,seats=[false,false,false];seats[seat]=true;
  const r=play(seats,T);if(r.winners.includes(seat))share+=1/r.winners.length}return pct(share/G)}

const G=+process.argv[2]||400;
for(const T of(process.argv[3]||'0,1,2,3').split(',').map(x=>x==='M'?'M':+x)){const s=shape(T,G);if(T)s['知っている1人の勝率']=edge(T,G);console.log(JSON.stringify(s))}
