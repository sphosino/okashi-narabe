// おかしならべのルール。画面のことは何も知らない（ブラウザでは window.Okashi、Node では require('./rules.js')）
//   cfg  ：{size, need, target, loveBonus, maxMoves, party}  盤の大きさ・並べる数・目標点・恋ボーナスのあり/なし・時間切れの手数・わいわい（アイテムあり）
//   状態 ：{cells, hands, scores, fixed, turn, moves}  わいわいのときは items, box, seed も
//          cells はマスごとに null（空き）か 0/1/2（誰のお菓子か）、fixed は恋モードのお菓子がいるマスの番号
//          items は各プレイヤーが持っているアイテム（1つまで）、box は盤に落ちているアイテム箱 {at:マス, k:アイテム}
//          seed は箱の落ちる場所と中身を決める種（同じ種なら、どこで回しても同じ試合になる）
//   手   ：{t:'place', to} 置く / {t:'move', from, to} 動かす / {t:'swap', from, to} 入れかえ / {t:'item', k, to} アイテムを使う
//          アイテムは、ふつうの1手の前に使える（使っても番は進まない）
// 状態は書きかえず、いつも新しい状態を返す
(function(root){
'use strict';
const MAXMOVES=150; // 長引いたらここで時間切れ（点が多い人の勝ち）
const DIR8=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

// 盤の形：NB[i] はマスiのとなり（ななめ含む）、WIN は「並び」になりうるマスの組
const geoCache=new Map();
function geo(cfg){
  const key=cfg.size+','+cfg.need;let g=geoCache.get(key);if(g)return g;
  const n=cfg.size,k=cfg.need,NB=[],WIN=[];
  for(let i=0;i<n*n;i++){const r=Math.floor(i/n),c=i%n,o=[];
    for(const[dr,dc]of DIR8){const rr=r+dr,cc=c+dc;if(rr>=0&&rr<n&&cc>=0&&cc<n)o.push(rr*n+cc)}NB.push(o)}
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){
    const er=r+dr*(k-1),ec=c+dc*(k-1);if(er<0||er>=n||ec<0||ec>=n)continue;
    const w=[];for(let s=0;s<k;s++)w.push((r+dr*s)*n+c+dc*s);WIN.push(w)}
  g={n,NB,WIN};geoCache.set(key,g);return g;
}
// 手持ちの数：「おまかせ」（auto）なら盤と並べる数から決める（4つ並べなら6個）。数を選んだらその数
const handFor=(size,need,sel)=>sel&&sel!=='auto'?+sel:need>=4?6:size>=6?5:4;
function newState(cfg,hand,start=0,seed=1){
  const st={cells:Array(cfg.size*cfg.size).fill(null),hands:[hand,hand,hand],scores:[0,0,0],fixed:[],turn:start,moves:0};
  if(cfg.party)Object.assign(st,{items:[null,null,null],box:null,seed:seed>>>0});
  return st;
}

// ===== わいわい：アイテム =====
//   arrow キューピッドの矢：自分のお菓子1つを恋モードに / dog いぬ：相手のお菓子1つを持ち主の手持ちに返す
//   rain 失恋の雨：盤の恋モードを全部とく / dove はと：自分の手持ちが1つ増える
const ITEMS=['arrow','dog','rain','dove'];
const SPAWN=4; // 盤に箱がないとき、この手数ごとに空きマスへ落ちてくる。4なら1試合に7個ほど拾われ、実力差もほぼ残る（tools/party-test.js）
// 種と番号から 0〜1 の数（どこで計算しても同じ）
function rnd(seed,n){let x=(seed^Math.imul(n+1,2654435761))>>>0;x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x/4294967296}
// アイテムを使える相手のマス。対象のいらないアイテムは [null]、使えないなら []
function itemTargets(cfg,st,k,p){
  if(k==='arrow')return st.cells.map((v,i)=>v===p&&!isLove(st,i)?i:-1).filter(i=>i>=0);
  if(k==='dog')return st.cells.map((v,i)=>v!==null&&v!==p?i:-1).filter(i=>i>=0);
  if(k==='rain')return st.fixed.length?[null]:[];
  if(k==='dove')return[null];
  return[];
}
function useItem(cfg,st,a,p){
  const cells=st.cells.slice(),hands=st.hands.slice(),items=st.items.slice();let fixed=st.fixed.slice(),victim=null;
  items[p]=null;
  if(a.k==='arrow')fixed.push(a.to);
  else if(a.k==='dog'){victim=cells[a.to];cells[a.to]=null;hands[victim]++;fixed=fixed.filter(i=>i!==a.to)}
  else if(a.k==='rain')fixed=[];
  else if(a.k==='dove')hands[p]++;
  return{state:{...st,cells,hands,fixed,items,moves:st.moves+1},victim,wake:false,loveTo:null,item:a.k};
}

function lines(cfg,cells){const out=[];
  for(const w of geo(cfg).WIN){const p=cells[w[0]];if(p!==null&&w.every(j=>cells[j]===p))out.push({p,w})}
  return out}

// 入れかえは何回でもOK。入れかえられた相手のお菓子は一目ぼれして「恋モード」になる。
// ふつう同士・恋モード同士なら入れかえられる（ふつうと恋モードは入れかえられない）。
// 恋モード同士で入れかえると、入れかえられた相手のお菓子は目がさめてふつうに戻る。空きマスへの移動はいつでもOK
const isLove=(st,i)=>st.fixed.includes(i);
function canSwap(st,i,j,p){const v=st.cells[j];return v!==null&&v!==p&&isLove(st,i)===isLove(st,j)}
function actions(cfg,st,p){const out=[],cells=st.cells,NB=geo(cfg).NB;
  if(cfg.party&&st.items&&st.items[p]){const k=st.items[p];for(const to of itemTargets(cfg,st,k,p))out.push({t:'item',k,to})}
  if(st.hands[p]>0)cells.forEach((v,i)=>{if(v===null)out.push({t:'place',to:i})});
  cells.forEach((v,i)=>{if(v!==p)return;for(const j of NB[i]){
    if(cells[j]===null)out.push({t:'move',from:i,to:j});
    else if(canSwap(st,i,j,p))out.push({t:'swap',from:i,to:j})}});
  return out}

// 手を打ったあとの盤（食べる前）
function simulate(st,a,p){const c=st.cells.slice();
  if(a.t==='place')c[a.to]=p;else if(a.t==='move'){c[a.to]=p;c[a.from]=null}else{const o=c[a.to];c[a.to]=p;c[a.from]=o}
  return c}
// 恋ボーナス：恋モードの自分のお菓子を動かした（入れかえ含む）手なら、そのお菓子の行き先。それ以外は null
const loveTo=(cfg,st,a)=>cfg.loveBonus&&a.t!=='place'&&isLove(st,a.from)?a.to:null;
// 揃った並び ls で各プレイヤーが取る点（並び1つにつき1点＋恋ボーナス）
function gainOf(ls,mover,lt){const g=[0,0,0];ls.forEach(l=>g[l.p]++);
  if(lt!==null&&ls.some(l=>l.p===mover&&l.w.includes(lt)))g[mover]++;return g}

// ① 置く・動かす・入れかえ。victim：入れかえられた相手、wake：恋モード同士で相手が目をさました
function act(cfg,st,a,p=st.turn){
  if(a.t==='item')return useItem(cfg,st,a,p);
  const cells=simulate(st,a,p),hands=st.hands.slice();let fixed=st.fixed.slice(),victim=null,wake=false;
  if(a.t==='place')hands[p]--;
  else if(a.t==='move'){const k=fixed.indexOf(a.from);if(k>=0)fixed[k]=a.to}
  else{victim=st.cells[a.to];
    if(isLove(st,a.from)&&isLove(st,a.to)){wake=true;fixed=fixed.filter(i=>i!==a.from)} // 恋モード同士：ぶつけられた相手のお菓子が目をさます
    else fixed.push(a.from)}                                                           // ふつう同士：ぶつけられた相手のお菓子が一目ぼれ
  const state={...st,cells,hands,fixed,moves:st.moves+1};let picked=null;
  if(cfg.party&&st.box&&a.to===st.box.at){const items=st.items.slice();picked=st.box.k;items[p]=picked;state.items=items;state.box=null} // 箱のマスに来たら拾う（持てるのは1つ。持っていたら入れかわる）
  return{state,victim,wake,loveTo:loveTo(cfg,st,a),picked};
}
// ② 揃った並びを食べて点を入れる。食べたお菓子は手持ちに戻る。winners：目標点に届いた人（同時なら打った人）
function eat(cfg,st,mover,lt=null){
  const ls=lines(cfg,st.cells);
  if(!ls.length)return{state:st,lines:ls,eaten:[],gain:[0,0,0],loved:false,winners:[]};
  const eaten=[...new Set(ls.flatMap(l=>l.w))],gain=gainOf(ls,mover,lt);
  const cells=st.cells.slice(),hands=st.hands.slice();
  eaten.forEach(i=>{hands[cells[i]]++;cells[i]=null});
  const scores=st.scores.map((s,q)=>Math.min(cfg.target,s+gain[q]));
  const w=[0,1,2].filter(q=>scores[q]>=cfg.target);
  return{state:{...st,cells,hands,scores,fixed:st.fixed.filter(i=>!eaten.includes(i))},
    lines:ls,eaten,gain,loved:gain[mover]>ls.filter(l=>l.p===mover).length,winners:w.length>1&&w.includes(mover)?[mover]:w};
}
// ③ 次の番へ。動けない人はパス。時間切れ・誰も動けないときは、その時点で点が多い人の勝ち
function next(cfg,st){
  const top=()=>{const m=Math.max(...st.scores);return[0,1,2].filter(q=>st.scores[q]===m)};
  if(st.moves>=(cfg.maxMoves??MAXMOVES))return{state:st,over:true,reason:'timeout',winners:top(),skipped:[]};
  let turn=st.turn;const skipped=[];
  for(let k=0;k<3;k++){turn=(turn+1)%3;if(actions(cfg,st,turn).length)break;skipped.push(turn)}
  if(skipped.length>=3)return{state:st,over:true,reason:'stuck',winners:top(),skipped};
  const ns={...st,turn};
  if(cfg.party&&!st.box&&st.moves>0&&st.moves%SPAWN===0){ // アイテム箱が落ちてくる
    const e=[];st.cells.forEach((v,i)=>{if(v===null)e.push(i)});
    if(e.length)ns.box={at:e[Math.floor(rnd(st.seed||1,st.moves*2)*e.length)],k:ITEMS[Math.floor(rnd(st.seed||1,st.moves*2+1)*ITEMS.length)]};
  }
  return{state:ns,over:false,reason:null,winners:[],skipped};
}
// ①②③をまとめて1手。シミュレーション用（画面では①②③の間にアニメーションをはさむ）
function step(cfg,st,a){
  const p=st.turn,m=act(cfg,st,a,p);
  if(a.t==='item')return{state:m.state,over:false,reason:null,winners:[],skipped:[],act:m,eat:{lines:[],eaten:[],gain:[0,0,0],loved:false,winners:[]}}; // アイテムでは番は進まない
  const e=eat(cfg,m.state,p,m.loveTo);
  if(e.winners.length)return{state:e.state,over:true,reason:'win',winners:e.winners,act:m,eat:e};
  const n=next(cfg,e.state);return{...n,act:m,eat:e};
}

const api={MAXMOVES,ITEMS,SPAWN,geo,handFor,newState,lines,isLove,canSwap,actions,itemTargets,simulate,loveTo,gainOf,act,eat,next,step};
if(typeof module==='object'&&module.exports)module.exports=api;else root.Okashi=api;
})(this);
