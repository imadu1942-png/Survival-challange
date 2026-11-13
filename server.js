// Survival Challenge server: serves the game page + WebSocket rooms.
// The server owns match timing, tile drops, eliminations and scoring. Clients only report their own position.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX = Math.max(1, +process.env.MAX_PLAYERS || 16);           // real capacity limit: set MAX_PLAYERS to match your server size
const SCORE = { survive: 100, checkpoint: 25, place: [100, 70, 50] }; // configurable
const N = 7, T = 4, H = 14, DUR = 45, CPS = [15, 30], FALL_MS = 1300;

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
});
const wss = new WebSocketServer({ server, maxPayload: 16384 });
const rooms = new Map();

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bc = (r, o) => r.players.forEach(p => send(p.ws, o));
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 14) || 'Player';
const pub = p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, connected: p.connected, voice: p.voice, muted: p.muted });
const roomMsg = r => ({ t: 'room', code: r.code, hostId: r.hostId, cap: r.cap, max: MAX, phase: r.phase, players: [...r.players.values()].map(pub) });
const pushRoom = r => bc(r, roomMsg(r));
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function addPlayer(r, name, color, ws) {
  let n = clean(name), k = 2; const taken = x => [...r.players.values()].some(p => p.name === x);
  const base = n; while (taken(n)) n = base.slice(0, 12) + ' ' + k++;
  const p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name: n,
    color: Number.isInteger(color) && color >= 0 && color <= 0xffffff ? color : 0xff6b9d, ws, connected: true,
    alive: true, voice: false, muted: false, pos: { x: 0, y: 0, z: 0, f: 0 }, lastPos: 0, dirty: false, elim: 0, cp: 0, total: 0, pts: 0, vt: 0, drop: null };
  r.players.set(p.id, p); return p;
}
function removePlayer(r, p) {
  clearTimeout(p.drop); r.players.delete(p.id);
  if (!r.players.size) { stopMatch(r); rooms.delete(r.code); return; }
  if (r.hostId === p.id) { const all = [...r.players.values()]; r.hostId = (all.find(x => x.connected) || all[0]).id; }
  pushRoom(r);
}
function stopMatch(r) { clearTimeout(r.timer); clearTimeout(r.m && r.m.ending); clearInterval(r.tick); }

function voidAt(r, x, z, now) {
  const i = Math.floor((x + H) / T), j = Math.floor((z + H) / T);
  if (i < 0 || j < 0 || i >= N || j >= N) return true;
  const w = r.tiles[i * N + j]; return !!w && now - w > FALL_MS;
}
function startMatch(r) {
  r.phase = 'count'; r.tiles = Array(N * N).fill(0); r.m = { t0: 0, last: 0, spawn: 2, cp: {}, ending: null };
  const ids = [...r.players.keys()], spawn = {};
  ids.forEach((id, i) => {
    const a = i / ids.length * Math.PI * 2, rad = ids.length > 1 ? Math.min(10, 3 + ids.length * .8) : 0, p = r.players.get(id);
    spawn[id] = [+(Math.cos(a) * rad).toFixed(2), +(Math.sin(a) * rad).toFixed(2)];
    Object.assign(p, { alive: true, elim: 0, cp: 0, total: 0, pts: 0, vt: 0, dirty: false, pos: { x: spawn[id][0], y: 0, z: spawn[id][1], f: 0 } });
  });
  bc(r, { t: 'start', spawn }); pushRoom(r);
  r.timer = setTimeout(() => { r.phase = 'play'; r.m.t0 = r.m.last = Date.now(); r.tick = setInterval(() => tick(r), 66); }, 3800);
}
function elim(r, p) {
  if (!p.alive) return;                       // prevents duplicate eliminations
  p.alive = false; p.elim = Date.now(); bc(r, { t: 'elim', id: p.id });
}
function tick(r) {
  if (r.phase !== 'play') return;
  const now = Date.now(), dt = Math.min(.2, (now - r.m.last) / 1000), el = (now - r.m.t0) / 1000; r.m.last = now;
  r.m.spawn -= dt;
  if (r.m.spawn <= 0) {
    const free = []; r.tiles.forEach((v, i) => { if (!v) free.push(i); });
    if (free.length > 3) { const i = free[crypto.randomInt(free.length)]; r.tiles[i] = now; bc(r, { t: 'tile', i }); }
    r.m.spawn = Math.max(.4, 1.4 - el * .022);
  }
  CPS.forEach(c => { if (el >= c && !r.m.cp[c]) { r.m.cp[c] = 1; r.players.forEach(p => { if (p.alive) p.cp++; }); } });
  const snap = {}; let any = false, alive = 0;
  r.players.forEach(p => {
    if (p.dirty) { snap[p.id] = [p.pos.x, p.pos.y, p.pos.z, p.pos.f]; p.dirty = false; any = true; }
    if (p.alive) {
      const q = p.pos;
      if (q.y < -12) elim(r, p);
      else if (q.y > -2 && voidAt(r, q.x, q.z, now)) { p.vt = p.vt || now; if (now - p.vt > 1500) elim(r, p); }
      else p.vt = 0;
    }
    if (p.alive) alive++;
  });
  if (any) bc(r, { t: 'snap', p: snap });
  if (el >= DUR) endMatch(r);
  else if (!alive && !r.m.ending) r.m.ending = setTimeout(() => endMatch(r), 2500);
}
function endMatch(r) {
  if (r.phase !== 'play') return;             // prevents duplicate score awards
  stopMatch(r); r.phase = 'result';
  const arr = [...r.players.values()].sort((a, b) => (b.alive - a.alive) || (b.elim - a.elim));
  arr.forEach((p, i) => {
    const rank = p.alive ? 1 : i + 1;
    const bonus = (p.alive || r.players.size > 1) ? (SCORE.place[rank - 1] || 0) : 0;
    p.pts = (p.alive ? SCORE.survive : 0) + p.cp * SCORE.checkpoint + bonus;
    p.total += p.pts;                         // Phase 3 will keep totals across rounds 2-5
  });
  const results = [...r.players.values()].sort((a, b) => b.total - a.total)
    .map((p, i) => ({ id: p.id, name: p.name, color: p.color, pts: p.pts, total: p.total, rank: i + 1, alive: p.alive }));
  bc(r, { t: 'end', results }); pushRoom(r);
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.cnt = 0; const rl = setInterval(() => { ws.cnt = 0; }, 1000);
  let room = null, me = null;
  ws.on('message', raw => {
    if (++ws.cnt > 120) { ws.close(); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const err = (msg, fatal) => send(ws, { t: 'err', msg, fatal: !!fatal });
    switch (m.t) {
      case 'create': {
        if (room) return;
        const code = newCode();
        room = { code, hostId: '', cap: Math.min(MAX, Math.max(1, parseInt(m.cap) || 4)), phase: 'lobby', players: new Map(), tiles: [], m: null };
        me = addPlayer(room, m.name, m.color, ws); room.hostId = me.id; rooms.set(code, room);
        send(ws, { t: 'welcome', id: me.id, token: me.token, code, max: MAX }); pushRoom(room); break;
      }
      case 'join': {
        if (room) return;
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (!r) return err('Room not found');
        if (r.phase !== 'lobby') return err('That match has already started');
        if (r.players.size >= r.cap) return err('Room is full');
        room = r; me = addPlayer(r, m.name, m.color, ws);
        send(ws, { t: 'welcome', id: me.id, token: me.token, code: r.code, max: MAX }); pushRoom(r); break;
      }
      case 'rejoin': {
        const r = rooms.get(String(m.code || '')), p = r && r.players.get(m.id);
        if (!p || p.token !== m.token) return err('Could not rejoin the room', true);
        clearTimeout(p.drop); p.ws = ws; p.connected = true; room = r; me = p;
        send(ws, { t: 'welcome', id: p.id, token: p.token, code: r.code, max: MAX }); pushRoom(r); break;
      }
      case 'cap': {
        if (!me || room.hostId !== me.id || room.phase !== 'lobby') break;
        const n = parseInt(m.n);
        if (n >= Math.max(1, room.players.size) && n <= MAX) { room.cap = n; pushRoom(room); }
        break;
      }
      case 'start':
        if (me && room.hostId === me.id && room.phase === 'lobby' && room.players.size >= room.cap) startMatch(room);
        break;
      case 'pos': {
        if (!me || room.phase !== 'play') break;
        const now = Date.now(), dtp = Math.min(1, (now - me.lastPos) / 1000); if (now - me.lastPos < 40) break;
        let x = +m.x, y = +m.y, z = +m.z, f = +m.f;
        if (![x, y, z, f].every(Number.isFinite) || Math.abs(x) > 40 || Math.abs(z) > 40 || y < -60 || y > 20) break;
        const l = me.pos, d = Math.hypot(x - l.x, z - l.z), maxD = .6 + dtp * 14;   // anti-teleport clamp
        if (d > maxD) { const k = maxD / d; x = l.x + (x - l.x) * k; z = l.z + (z - l.z) * k; }
        me.pos = { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), f: +f.toFixed(2) }; me.lastPos = now; me.dirty = true; break;
      }
      case 'fell':
        if (me && room.phase === 'play' && me.alive && me.pos.y < -8) elim(room, me);
        break;
      case 'voice':
        if (me) { me.voice = !!m.on; me.muted = me.voice && !!m.muted; pushRoom(room); }
        break;
      case 'sig': {
        if (!me) break;
        const to = room.players.get(m.to);
        const size = JSON.stringify(m.data || {}).length;
        if (size > 12000) { err('Voice setup message too large (' + size + ' chars) and was dropped'); break; }
        if (!to || !to.ws) { send(ws, { t: 'sigfail', to: m.to, why: 'player offline' }); break; }
        send(to.ws, { t: 'sig', from: me.id, data: m.data });
        break;
      }
      case 'lobby':
        if (me && room.hostId === me.id && room.phase === 'result') { room.phase = 'lobby'; room.players.forEach(p => { p.alive = true; }); pushRoom(room); }
        break;
      case 'leave':
        if (me) { removePlayer(room, me); room = null; me = null; }
        break;
    }
  });
  ws.on('close', () => {
    clearInterval(rl);
    if (me && me.ws === ws) {
      const r = room, p = me; p.connected = false; p.ws = null; pushRoom(r);
      p.drop = setTimeout(() => removePlayer(r, p), 30000);   // 30 s to reconnect
    }
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);
server.listen(process.env.PORT || 3000, () => console.log('Survival Challenge server on port ' + (process.env.PORT || 3000) + ', max players per room ' + MAX));
