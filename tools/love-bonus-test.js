// 恋ボーナスをCPU同士で比べる（ルールとCPUはゲームと同じ rules.js / cpu.js。CPUは「ふつう」）
//   ・ボーナスなし／ありで、試合の形（手数・手の内訳・席ごとの勝率など）がどう変わるか
//   ・ボーナスありのとき、ボーナスを知っている1人が、知らない2人に勝てるか（知っていて得なら、狙って取る技になっている）
// 使い方: node tools/love-bonus-test.js [試合数]
const R=require('../rules.js'),CPU=require('../cpu.js');
const base={size:6,need:4,target:3,maxMoves:R.MAXMOVES},HAND=R.handFor(base.size,base.need);

// rule：本当のルール。aware[席]：その席のCPUがボーナスを知っているか（知らないCPUは「ボーナスなし」だと思って打つ）
function play(rule,aware,start){
  const think=[0,1,2].map(q=>({...rule,loveBonus:rule.loveBonus&&aware[q]}));
  let st=R.newState(rule,HAND,start);const s={place:0,move:0,swap:0,lines:0,bonus:0};
  while(true){const p=st.turn,a=CPU.choose(think[p],st,p,'normal'),r=R.step(rule,st,a);
    s[a.t]++;s.lines+=r.eat.lines.length;if(r.eat.loved)s.bonus++;st=r.state;
    if(r.over)return{...s,winners:r.winners,moves:st.moves}}
}
const pct=x=>(x*100).toFixed(1)+'%',med=a=>a.slice().sort((x,y)=>x-y)[a.length>>1];
function shape(loveBonus,G){
  const rule={...base,loveBonus},seat=[0,0,0],mv=[];let n={place:0,move:0,swap:0,lines:0,bonus:0},draws=0;
  for(let g=0;g<G;g++){const r=play(rule,[true,true,true],0);for(const k in n)n[k]+=r[k];mv.push(r.moves);
    if(r.winners.length>1)draws++;else seat[r.winners[0]]++}
  const acts=n.place+n.move+n.swap;
  return{恋ボーナス:loveBonus?'あり':'なし',手数中央値:med(mv),置く:pct(n.place/acts),動かす:pct(n.move/acts),入れかえ:pct(n.swap/acts),
    ボーナスがついた並び:pct(n.bonus/Math.max(n.lines,1)),引き分け:pct(draws/G),席ごとの勝率:seat.map(x=>pct(x/G)).join('/')};
}
function edge(G){ // 知っている1人 対 知らない2人（席は回す）。互角なら33%
  let share=0;for(let g=0;g<G;g++){const seat=g%3,aware=[false,false,false];aware[seat]=true;
    const r=play({...base,loveBonus:true},aware,0);if(r.winners.includes(seat))share+=1/r.winners.length}
  return pct(share/G);
}
const G=+process.argv[2]||400;
console.log(JSON.stringify(shape(false,G)));
console.log(JSON.stringify(shape(true,G)));
console.log(JSON.stringify({知っている1人の勝率:edge(G)}));
