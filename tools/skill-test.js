// CPU同士を大量に戦わせて、実力差がどれくらい勝敗に出るかを調べる（ルールとCPUはゲームと同じ rules.js / cpu.js）
// 使い方: node tools/skill-test.js [試合数]
const R=require('../rules.js'),CPU=require('../cpu.js');
const C={size:6,need:4,target:3,loveBonus:true,maxMoves:R.MAXMOVES},HAND=R.handFor(C.size,C.need);

// プレイヤーの頭：ゲーム内のCPU3段階と、比べるための2つ
const BRAINS={
  hard:(st,p)=>CPU.choose(C,st,p,'hard'),     // つよい
  normal:(st,p)=>CPU.choose(C,st,p,'normal'), // ふつう
  easy:(st,p)=>CPU.choose(C,st,p,'easy'),     // やさしい
  greedy:(st,p)=>{ // 欲張り：揃えられるなら揃える。それ以外は適当（守りも先読みもしない）
    let best=null,bs=-Infinity;
    for(const a of R.actions(C,st,p)){let s=Math.random()*10;for(const l of R.lines(C,R.simulate(st,a,p)))s+=l.p===p?100:-100;if(s>bs){bs=s;best=a}}
    return best},
  random:(st,p)=>{const a=R.actions(C,st,p);return a[Math.floor(Math.random()*a.length)]}, // 適当
};
function play(seats){ // seats: 3人の頭（席順＝手番順、0番が先手）
  let st=R.newState(C,HAND,0);
  while(true){const r=R.step(C,st,BRAINS[seats[st.turn]](st,st.turn));st=r.state;if(r.over)return{winners:r.winners,moves:st.moves,timeout:r.reason!=='win'}}
}
// 調べたい頭を1人、相手2人。席は3通り順番に回して公平にする。同点は勝ちを分け合う
function trial(hero,foe,games){
  let share=0,moves=0,to=0;
  for(let g=0;g<games;g++){const seat=g%3,seats=[foe,foe,foe];seats[seat]=hero;
    const r=play(seats);moves+=r.moves;if(r.timeout)to++;if(r.winners.includes(seat))share+=1/r.winners.length}
  return{hero,foe,games,winRate:(share/games*100).toFixed(1)+'%',avgMoves:(moves/games).toFixed(0),timeouts:to};
}
const G=+process.argv[2]||300;
console.log(JSON.stringify(trial('hard','normal',Math.ceil(G/2)))); // つよいは遅いので半分
console.log(JSON.stringify(trial('normal','easy',G)));
console.log(JSON.stringify(trial('easy','normal',G)));
console.log(JSON.stringify(trial('easy','greedy',G)));
console.log(JSON.stringify(trial('easy','random',G)));
