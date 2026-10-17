// 友人戦のサーバー（Cloudflare Workers + Durable Objects）。部屋1つが Durable Object 1つ
//   GET  /rooms                         部屋の一覧（人待ち・途中参加できる部屋が先）
//   POST /rooms            {pid, name, char} → {id}  部屋を作る（作った人が席0に座る）
//   GET  /rooms/<id>/ws?pid=…           WebSocket でつなぐ
// WebSocket で受けるもの：{t:'join', name, char} / {t:'char', c} / {t:'start'} / {t:'act', game, n, a} / {t:'again'} / {t:'listed', on} / {t:'stamp', k}
// スタンプは保存せず、座っている人から来たものを、ほかの人に {t:'stamp', p, k} で配るだけ
// {t:'limit', sec} / {t:'rule', rule}：持ち時間・ルールを決める（部屋を作った人、集まり中）。{t:'leave'}：部屋を出る（席は CPU に）
// {t:'timeout'}：座っている人のブラウザが、締め切りを過ぎたら送る。その1手は CPU、2回続けたら退室扱い
// ハートビート：ブラウザは20秒ごとに 'ping' を送り、サーバーは起こされずに 'pong' を返す。70秒来ない回線は「るす」とみなす
// 部屋の一覧は Lobby（Durable Object 1つ）が持つ。部屋は変わるたびに Lobby に知らせる
// 送るもの：{t:'room', room:<その人向けの様子>, move?:<今打たれた手>} / {t:'err', msg}
// 三人将棋の部屋（kind:'shogi3'）も同じしくみ。POST /rooms に kind:'shogi3' をつけて作り、GET /rooms?kind=shogi3 で一覧を見る
//   ちがうところ：{t:'act', game, n, a:<手>} の手は将棋の手、{t:'resign', game} で投了、rule は all / next / off、キャラはない（ルールは shogi-room.js）
import { DurableObject } from 'cloudflare:workers';
import * as OK from './game.js';
import * as SH from './shogi-room.js';
import * as DA from './daruma-room.js';
const KINDS = { okashi: OK, shogi3: SH, daruma: DA };
const rulesOf = (room) => KINDS[room.kind] || OK; // kind のない部屋はおかしならべ

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
const PID = /^[a-z0-9]{16,40}$/, RID = /^[a-z0-9]{8}$/;
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789'; // 読み間違えやすい文字（i l o 0 1）は使わない
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ABC[b % ABC.length]).join('');
const KEEP_MS = 30 * 24 * 3600 * 1000; // 30日だれも触らなかった部屋は消す
const lobby = (env) => env.LOBBY.get(env.LOBBY.idFromName('main'));
const STAMPS = ['hi', 'nice', 'doki', 'eh', 'ouch', 'grr', 'thx', 'again'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'GET' && url.pathname === '/rooms') return json({ rooms: await lobby(env).list(KINDS[url.searchParams.get('kind')] ? url.searchParams.get('kind') : 'okashi') });
    if (req.method === 'POST' && url.pathname === '/rooms') {
      const body = await req.json().catch(() => ({}));
      if (!PID.test(body.pid ?? '')) return json({ error: 'pid がおかしいです' }, 400);
      const id = newId();
      await env.ROOM.get(env.ROOM.idFromName(id)).init(id, body.pid, body.name, body.char, KINDS[body.kind] ? body.kind : 'okashi');
      return json({ id });
    }
    const m = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/ws$/);
    if (m && RID.test(m[1])) {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'WebSocket でつないでください' }, 426);
      if (!PID.test(url.searchParams.get('pid') ?? '')) return json({ error: 'pid がおかしいです' }, 400);
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return json({ error: 'not found' }, 404);
  },
};

const STALE_MS = 70 * 1000;
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  secMs() { return Number(this.env.SEC_MS) || 1000; } // 1秒の長さ。手元で試すときだけ縮める（wrangler dev --var SEC_MS:100）
  async init(id, pid, name, char, kind = 'okashi') {
    if (await this.ctx.storage.get('room')) throw new Error('もうある部屋です');
    await this.save(KINDS[kind].newRoom(id, pid, name, char));
  }
  // 部屋の様子。だるま（リアルタイム）はメモリにも持つ。タイマーとメッセージが同じものを書きかえるように
  async getRoom() {
    if (this.live) return this.live;
    const room = await this.ctx.storage.get('room');
    if (room && room.kind === 'daruma') this.live = room;
    return room;
  }
  async save(room) {
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
  }
  async alarm() {
    const room = await this.ctx.storage.get('room');
    if (room) await lobby(this.env).remove(room.id).catch(() => {});
    await this.ctx.storage.deleteAll();
  }
  // 部屋の一覧に今の様子を知らせる（失敗しても対戦は止めない）
  async report(room) { try { await lobby(this.env).update(rulesOf(room).summary(room, this.online())); } catch (e) {} }

  // つながっている回線。ping が70秒来ていないものは切れたとみなして閉じる
  sockets() {
    const now = Date.now();
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (ts && now - ts.getTime() > STALE_MS) { try { ws.close(1000, 'stale'); } catch (e) {} return false; }
      return true;
    });
  }
  online() { return new Set(this.sockets().map((ws) => this.ctx.getTags(ws)[0])); }
  // つながっている全員に、それぞれ向けの様子を配る
  broadcast(room, move, extra) {
    const on = this.online();
    for (const ws of this.sockets()) {
      const v = rulesOf(room).view(room, this.ctx.getTags(ws)[0], on, this.secMs());
      try { ws.send(JSON.stringify({ t: 'room', room: v, move, ...extra })); } catch (e) {}
    }
  }

  async fetch(req) {
    const room = await this.getRoom();
    if (!room) return new Response('この部屋はありません', { status: 404, headers: CORS });
    const pid = new URL(req.url).searchParams.get('pid');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [pid]);
    this.broadcast(room); // 自分には今の様子、ほかの人には「来た」ことが伝わる
    this.ctx.waitUntil(this.report(room));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const pid = this.ctx.getTags(ws)[0];
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    const room = await this.getRoom();
    if (!room) return;
    const G = rulesOf(room);
    // だるま（リアルタイム）の入力・時計合わせ・言う・振り向く は daruma-room.js がまとめて扱う
    if (G.onMessage) {
      const api = {
        now: () => Date.now(),
        save: () => { this.ctx.storage.put('room', room); },
        broadcast: (extra) => this.broadcast(room, undefined, extra),
        later: (ms, fn) => { setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, ms); },
      };
      const r = G.onMessage(api, room, pid, msg);
      if (r && r.reply) { ws.send(JSON.stringify(r.reply)); return; }
      if (typeof r === 'string') { ws.send(JSON.stringify({ t: 'err', msg: r })); return; }
      if (r === null) return;
    }
    if (msg.t === 'timeout') {
      const res = G.timeout(room, pid, this.online(), Date.now(), this.secMs());
      if (typeof res === 'string' || !res) return;
      await this.save(room); if (res.why === 'timeout2') await this.report(room);
      this.broadcast(room, undefined, { left: res });
      return;
    }
    if (msg.t === 'leave') {
      const res = G.leave(room, pid);
      if (typeof res === 'string') { ws.send(JSON.stringify({ t: 'err', msg: res, room: G.view(room, pid, this.online()) })); return; }
      await this.save(room); await this.report(room);
      this.broadcast(room, undefined, { left: res });
      return;
    }
    if (msg.t === 'stamp') {
      const p = G.seatOf(room, pid), now = Date.now(), last = (this.lastStamp ??= new Map()).get(pid) || 0;
      if (p < 0 || !STAMPS.includes(msg.k) || now - last < 1000) return; // 座っている人だけ、連打はしない
      this.lastStamp.set(pid, now);
      const out = JSON.stringify({ t: 'stamp', p, k: msg.k });
      for (const w of this.sockets()) if (w !== ws) try { w.send(out); } catch (e) {}
      return;
    }
    let res = null;
    if (msg.t === 'join') res = G.join(room, pid, msg.name, msg.char);
    else if (msg.t === 'char') res = G.setChar(room, pid, msg.c);
    else if (msg.t === 'start') res = G.start(room, pid);
    else if (msg.t === 'act') res = G.act(room, pid, msg.game, msg.n, msg.a);
    else if (msg.t === 'again') res = G.again(room, pid);
    else if (msg.t === 'listed') res = G.setListed(room, pid, msg.on);
    else if (msg.t === 'limit') res = G.setLimit(room, pid, msg.sec);
    else if (msg.t === 'rule') res = G.setRule(room, pid, msg.rule);
    else if (msg.t === 'resign' && G.resign) res = G.resign(room, pid, msg.game);
    else return;
    if (typeof res === 'string') { // うまくいかなかった：理由と、今の正しい様子を本人に返す
      ws.send(JSON.stringify({ t: 'err', msg: res, room: G.view(room, pid, this.online()) }));
      return;
    }
    await this.save(room);
    this.broadcast(room, res || undefined);
    if (msg.t !== 'act' || room.phase === 'over' || room.state.moves === 1) await this.report(room); // 1手ごとには知らせない
  }
  async left(ws) {
    const room = await this.getRoom(); if (!room) return;
    const pid = this.ctx.getTags(ws)[0];
    if (OK.seatOf(room, pid) >= 0 && !this.online().has(pid)) { OK.markSeen(room, pid, Date.now()); await this.ctx.storage.put('room', room); }
    this.broadcast(room); await this.report(room);
  }
  async webSocketClose(ws) { await this.left(ws); }
  async webSocketError(ws) { await this.left(ws); }
}

// 部屋の一覧。r:<id> に各部屋の summary を持つ
const LOBBY_SHOW = 30, DROP_MS = 2 * 24 * 3600 * 1000;
export class Lobby extends DurableObject {
  async update(info) { await this.ctx.storage.put('r:' + info.id, info); }
  async remove(id) { await this.ctx.storage.delete('r:' + id); }
  async list(kind = 'okashi') {
    const now = Date.now(), out = [], old = [];
    for (const [k, r] of await this.ctx.storage.list({ prefix: 'r:' })) {
      if (now - r.updated > DROP_MS) { old.push(k); continue; }
      if ((r.kind || 'okashi') !== kind) continue;
      const here = r.seats.some((s) => s && s.online);
      // 誰かがいる部屋だけ見せる（誰もいない部屋に入っても、戻ってくるまで何も起きないので）
      if (!r.listed || !here) continue;
      out.push({ ...r, open: r.seats.includes(null), here });
    }
    if (old.length) await this.ctx.storage.delete(old);
    const rank = (r) => (r.phase === 'lobby' ? 0 : r.open ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || b.updated - a.updated).slice(0, LOBBY_SHOW);
  }
}
