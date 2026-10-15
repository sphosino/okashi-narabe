// 友人戦の通信。画面のことは何も知らない（ブラウザでは window.OkashiRoom）
//   list()                    部屋の一覧を返す（人待ち・途中参加できる部屋が先）
//   create(name, char)        部屋を作って id を返す（char は好きなキャラ）
//   connect(id, onMsg)        つなぐ。切れたらつなぎ直す。onMsg にサーバーからの {t, room, move, msg} を渡す
//   send(msg)                 {t:'join'|'start'|'act'|'again', …} を送る
//   me()                      このブラウザの番号（pid）。席を覚えておくための秘密の番号
// サーバーの場所：mataasobo.com なら api.mataasobo.com、手元で開いたときは http://127.0.0.1:8787（wrangler dev）
(function(root){
'use strict';
const API=location.hostname==='mataasobo.com'?'https://api.mataasobo.com':'http://127.0.0.1:8787';
const ABC='abcdefghjkmnpqrstuvwxyz23456789';
function me(){
  let p=null;try{p=localStorage.getItem('mataasobo-pid')}catch(e){}
  if(!/^[a-z0-9]{16,40}$/.test(p||'')){p=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>ABC[b%ABC.length]).join('');try{localStorage.setItem('mataasobo-pid',p)}catch(e){}}
  return p;
}
async function list(){const r=await fetch(API+'/rooms');if(!r.ok)throw new Error('一覧を取れませんでした');return (await r.json()).rooms}
async function create(name,char){
  const r=await fetch(API+'/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pid:me(),name,char})});
  const j=await r.json();if(!r.ok)throw new Error(j.error||'部屋を作れませんでした');return j.id;
}
let ws=null,queue=[],wait=1000,timer=null;
function connect(id,onMsg){
  const open=()=>{
    clearTimeout(timer);
    const s=ws=new WebSocket(API.replace(/^http/,'ws')+'/rooms/'+id+'/ws?pid='+me());
    s.onopen=()=>{wait=1000;queue.splice(0).forEach(m=>s.send(m));onMsg({t:'open'})};
    s.onmessage=e=>{try{onMsg(JSON.parse(e.data))}catch(err){console.error(err)}};
    s.onclose=()=>{if(s!==ws)return;onMsg({t:'close'});timer=setTimeout(open,wait);wait=Math.min(wait*2,10000)}; // 少しずつ間をあけてつなぎ直す
  };
  open();
  // スマホでアプリを切りかえて戻ってきたら、すぐつなぎ直す
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&ws&&ws.readyState>1){wait=1000;open()}});
}
function send(msg){const s=JSON.stringify(msg);if(ws&&ws.readyState===1)ws.send(s);else queue.push(s)}
root.OkashiRoom={list,create,connect,send,me,API};
})(this);
