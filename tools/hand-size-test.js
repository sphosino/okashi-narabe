// 手持ちの数（5〜8個）で、時間切れや「動かす」の割合がどう変わるかをCPU同士で調べる（恋ボーナスあり、CPUは「ふつう」）
// 使い方: node tools/hand-size-test.js [試合数] [盤の大きさ]
const R=require('../rules.js'),CPU=require('../cpu.js');
const G=+process.argv[2]||300,size=+process.argv[3]||6;
const pct=x=>(x*100).toFixed(1)+'%',med=a=>a.slice().sort((x,y)=>x-y)[a.length>>1];
for(const hand of[5,6,7,8]){
  const C={size,need:4,target:3,loveBonus:true,maxMoves:R.MAXMOVES};
  let to=0,draws=0;const n={place:0,move:0,swap:0,bonus:0,lines:0},mv=[],seat=[0,0,0];
  for(let g=0;g<G;g++){let st=R.newState(C,hand,0);
    while(true){const a=CPU.choose(C,st,st.turn,'normal'),r=R.step(C,st,a);
      n[a.t]++;n.lines+=r.eat.lines.length;if(r.eat.loved)n.bonus++;st=r.state;
      if(r.over){if(r.reason!=='win')to++;if(r.winners.length>1)draws++;else seat[r.winners[0]]++;mv.push(st.moves);break}}}
  const acts=n.place+n.move+n.swap;
  console.log(JSON.stringify({盤:size+'×'+size,手持ち:hand,時間切れ:pct(to/G),引き分け:pct(draws/G),手数中央値:med(mv),
    動かす:pct(n.move/acts),入れかえ:pct(n.swap/acts),ボーナスがついた並び:pct(n.bonus/Math.max(n.lines,1)),席ごとの勝率:seat.map(x=>pct(x/G)).join('/')}));
}
