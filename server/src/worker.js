// 友人戦のサーバー（Cloudflare Workers + Durable Objects）。部屋1つが Durable Object 1つ
//   GET  /rooms                         部屋の一覧（人待ち・途中参加できる部屋が先）
//   POST /rooms            {pid, name} → {id}  部屋を作る（作った人が席0に座る）
//   GET  /rooms/<id>/ws?pid=…           WebSocket でつなぐ
// WebSocket で受けるもの：{t:'join', name} / {t:'start'} / {t:'act', game, n, a} / {t:'again'} / {t:'listed', on} / {t:'stamp', k}
// スタンプは保存せず、座っている人から来たものを、ほかの人に {t:'stamp', p, k} で配るだけ
// 部屋の一覧は Lobby（Durable Object 1つ）が持つ。部屋は変わるたびに Lobby に知らせる
// 送るもの：{t:'room', room:<その人向けの様子>, move?:<今打たれた手>} / {t:'err', msg}
import { DurableObject } from 'cloudflare:workers';
import * as G from './game.js';

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
    if (req.method === 'GET' && url.pathname === '/rooms') return json({ rooms: await lobby(env).list() });
    if (req.method === 'POST' && url.pathname === '/rooms') {
      const body = await req.json().catch(() => ({}));
      if (!PID.test(body.pid ?? '')) return json({ error: 'pid がおかしいです' }, 400);
      const id = newId();
      await env.ROOM.get(env.ROOM.idFromName(id)).init(id, body.pid, body.name);
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

export class Room extends DurableObject {
  async init(id, pid, name) {
    if (await this.ctx.storage.get('room')) throw new Error('もうある部屋です');
    await this.save(G.newRoom(id, pid, name));
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
  async report(room) { try { await lobby(this.env).update(G.summary(room, this.online())); } catch (e) {} }

  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN); }
  online() { return new Set(this.sockets().map((ws) => this.ctx.getTags(ws)[0])); }
  // つながっている全員に、それぞれ向けの様子を配る
  broadcast(room, move) {
    const on = this.online();
    for (const ws of this.sockets()) {
      try { ws.send(JSON.stringify({ t: 'room', room: G.view(room, this.ctx.getTags(ws)[0], on), move })); } catch (e) {}
    }
  }

  async fetch(req) {
    const room = await this.ctx.storage.get('room');
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
    const room = await this.ctx.storage.get('room');
    if (!room) return;
    if (msg.t === 'stamp') {
      const p = G.seatOf(room, pid), now = Date.now(), last = (this.lastStamp ??= new Map()).get(pid) || 0;
      if (p < 0 || !STAMPS.includes(msg.k) || now - last < 1000) return; // 座っている人だけ、連打はしない
      this.lastStamp.set(pid, now);
      const out = JSON.stringify({ t: 'stamp', p, k: msg.k });
      for (const w of this.sockets()) if (w !== ws) try { w.send(out); } catch (e) {}
      return;
    }
    let res = null;
    if (msg.t === 'join') res = G.join(room, pid, msg.name);
    else if (msg.t === 'start') res = G.start(room, pid);
    else if (msg.t === 'act') res = G.act(room, pid, msg.game, msg.n, msg.a);
    else if (msg.t === 'again') res = G.again(room, pid);
    else if (msg.t === 'listed') res = G.setListed(room, pid, msg.on);
    else return;
    if (typeof res === 'string') { // うまくいかなかった：理由と、今の正しい様子を本人に返す
      ws.send(JSON.stringify({ t: 'err', msg: res, room: G.view(room, pid, this.online()) }));
      return;
    }
    await this.save(room);
    this.broadcast(room, res || undefined);
    if (msg.t !== 'act' || room.phase === 'over' || room.state.moves === 1) await this.report(room); // 1手ごとには知らせない
  }
  async left() { const room = await this.ctx.storage.get('room'); if (room) { this.broadcast(room); await this.report(room); } }
  async webSocketClose(ws) { await this.left(); }
  async webSocketError(ws) { await this.left(); }
}

// 部屋の一覧。r:<id> に各部屋の summary を持つ
const LOBBY_SHOW = 30, DROP_MS = 2 * 24 * 3600 * 1000;
export class Lobby extends DurableObject {
  async update(info) { await this.ctx.storage.put('r:' + info.id, info); }
  async remove(id) { await this.ctx.storage.delete('r:' + id); }
  async list() {
    const now = Date.now(), out = [], old = [];
    for (const [k, r] of await this.ctx.storage.list({ prefix: 'r:' })) {
      if (now - r.updated > DROP_MS) { old.push(k); continue; }
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
