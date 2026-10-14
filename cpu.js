// おかしならべのCPU。rules.js だけを使う（ブラウザでは window.OkashiCPU、Node では require('./cpu.js')）
//   choose(cfg, 状態, p, level)：p の打つ手を選ぶ。level は 'easy'（やさしい）/ 'normal'（ふつう）/ 'hard'（つよい）
//   cfg は「CPUが思っているルール」。本当のルールと変えれば、ルールを知らないCPUも作れる
(function(root){
'use strict';
const R=typeof module==='object'&&module.exports?require('./rules.js'):root.Okashi;

// qが次の一手で揃えられる並びの数。fixed は恋モードのマスの Set
function threats(cfg,c,q,hands,fixed){
  let t=0;const k=cfg.need,{NB,WIN}=R.geo(cfg);
  for(const w of WIN){
    let own=0,empty=-1,ne=0,g=-1;for(const j of w){if(c[j]===q)own++;else if(c[j]===null){ne++;empty=j}else g=j}
    if(own!==k-1)continue;
    // 恋ボーナスありなら、恋モードのお菓子を動かして揃えられる並びは2点ぶんとして数える
    const by=ok=>NB[ne===1?empty:g].filter(j=>c[j]===q&&!w.includes(j)&&ok(j));
    // 最後の1マスが空いている：置くか、となりから動かして揃う
    if(ne===1){if(cfg.loveBonus&&by(j=>fixed.has(j)).length)t+=2;else if(hands[q]>0||by(()=>true).length)t++}
    // 最後の1マスに他人のお菓子：となりに同じモード（ふつう同士・恋モード同士）の自分のお菓子があれば、入れかえて揃う
    else if(by(j=>fixed.has(j)===fixed.has(g)).length)t+=cfg.loveBonus&&fixed.has(g)?2:1;
  }
  return t;
}
// 揃いかけ（あと2つ）の並びの数
function buildup(cfg,c,q){
  let t=0;const k=cfg.need;if(k<4)return 0;
  for(const w of R.geo(cfg).WIN){let own=0,ne=0;for(const j of w){if(c[j]===q)own++;else if(c[j]===null)ne++}if(own===k-2&&ne===2)t++}
  return t;
}
// 手を打って食べ終わった後の状態
const applyOn=(cfg,st,a,p)=>{const m=R.act(cfg,st,a,p);return R.eat(cfg,m.state,p,m.loveTo)};

// ふつう：1手先を全部試して、自分と相手の「あと1つ」の数で選ぶ。動かした跡や入れかえで相手に道を開けないかも見る
function evalNormal(cfg,st,a,p){
  const e=applyOn(cfg,st,a,p),gain=e.gain;
  let s=0;
  if(gain[p])s+=st.scores[p]+gain[p]>=cfg.target?10000:120*gain[p];
  for(const q of[0,1,2])if(q!==p)s-=90*gain[q];
  // 食べられた後の盤で評価
  const after=e.state.cells,hands=e.state.hands,fx=new Set(e.state.fixed);
  s+=threats(cfg,after,p,hands,fx)*14+buildup(cfg,after,p)*3-buildup(cfg,after,(p+1)%3)*1.5;
  const nx=(p+1)%3,nx2=(p+2)%3,reach=cfg.loveBonus?2:1; // reach：次の一手で取りうる点
  s-=threats(cfg,after,nx,hands,fx)*(st.scores[nx]+reach>=cfg.target?60:22);
  s-=threats(cfg,after,nx2,hands,fx)*(st.scores[nx2]+reach>=cfg.target?40:14);
  if(a.t==='swap'&&!e.lines.some(l=>l.p===p))s-=3;
  if(a.t==='place')s+=2;
  const n=cfg.size,mid=(n-1)/2;s-=(Math.abs(Math.floor(a.to/n)-mid)+Math.abs(a.to%n-mid))*.6;
  return s+Math.random()*4;
}
// やさしい：目の前だけ見る（揃える・相手の「あと1つ」のマスをふさぐ・自分の「あと1つ」を増やす）
function openSpots(cfg,c,q){const s=new Set(),k=cfg.need;
  for(const w of R.geo(cfg).WIN){let own=0,e=-1,ne=0;for(const j of w){if(c[j]===q)own++;else if(c[j]===null){ne++;e=j}}if(own===k-1&&ne===1)s.add(e)}
  return s}
function evalEasy(cfg,st,a,p){
  const c=R.simulate(st,a,p),gain=R.gainOf(R.lines(cfg,c),p,R.loveTo(cfg,st,a));let s=0;
  for(const q of[0,1,2])s+=(q===p?100:-100)*gain[q];
  for(const q of[(p+1)%3,(p+2)%3])if(openSpots(cfg,st.cells,q).has(a.to))s+=30;
  s+=openSpots(cfg,c,p).size*10+R.geo(cfg).NB[a.to].filter(j=>c[j]===p).length*2;
  return s+Math.random()*3;
}
// つよい：2手読み。よさそうな手を10個にしぼり、それぞれに次の人の一番いい返しを当てて、その後の盤で選ぶ
function boardValue(cfg,T,p){ // 次の人が打ち終わった盤を、pから見て点数にする
  const nx=(p+1)%3,nx2=(p+2)%3,fx=new Set(T.fixed);
  if(T.scores[p]>=cfg.target)return 1e6;if(T.scores[nx]>=cfg.target||T.scores[nx2]>=cfg.target)return -1e6;
  let v=T.scores[p]*300-(T.scores[nx]+T.scores[nx2])*150;
  v+=threats(cfg,T.cells,p,T.hands,fx)*14+buildup(cfg,T.cells,p)*3;
  v-=threats(cfg,T.cells,nx2,T.hands,fx)*(T.scores[nx2]+(cfg.loveBonus?2:1)>=cfg.target?60:22); // この次に打つのは nx2
  v-=threats(cfg,T.cells,nx,T.hands,fx)*14;
  return v;
}
function pickHard(cfg,st,p){
  const cand=R.actions(cfg,st,p).map(a=>({a,v:evalNormal(cfg,st,a,p)})).sort((x,y)=>y.v-x.v).slice(0,10);
  let best=cand[0].a,bs=-Infinity;
  for(const {a} of cand){
    const S1=applyOn(cfg,st,a,p).state;if(S1.scores[p]>=cfg.target)return a;
    const nx=(p+1)%3,acts=R.actions(cfg,S1,nx);let b=null,bv=-Infinity;
    for(const x of acts){const v=evalNormal(cfg,S1,x,nx);if(v>bv){bv=v;b=x}}
    const v=boardValue(cfg,b?applyOn(cfg,S1,b,nx).state:S1,p)+Math.random()*2;
    if(v>bs){bs=v;best=a}
  }
  return best;
}
// p の打つ手を選ぶ。打てる手がなければ null
function choose(cfg,st,p,level='normal'){
  const acts=R.actions(cfg,st,p);if(!acts.length)return null;
  if(level==='hard')return pickHard(cfg,st,p);
  const f=level==='easy'?evalEasy:evalNormal;let best=acts[0],bs=-Infinity;
  for(const a of acts){const s=f(cfg,st,a,p);if(s>bs){bs=s;best=a}}
  return best;
}

const api={choose,evalNormal,evalEasy,threats,buildup,openSpots};
if(typeof module==='object'&&module.exports)module.exports=api;else root.OkashiCPU=api;
})(this);
