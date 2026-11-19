// Shared-state WebSocket server for Casino 3D.
// Run: npm install && npm start
// Use WSS behind HTTPS for public internet deployment.
const WebSocket = require('ws');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 8080);
const wss = new WebSocket.Server({ port: PORT, maxPayload: 16 * 1024 });

const rooms = new Map();
const roomData = new Map();
const ACTIONS_PER_SECOND = 12;

function members(room) { return rooms.get(room) || new Set(); }
function dataFor(room) {
  if (!roomData.has(room)) roomData.set(room, { hostUid: null, sharedState: null, actionSeq: 0 });
  return roomData.get(room);
}
function send(ws, packet) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet));
}
function broadcast(room, packet) {
  for (const client of members(room)) send(client, packet);
}
function presence(room) { broadcast(room, { type: 'presence', count: members(room).size }); }
function cleanRoom(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function clampNum(value, min, max, fallback = min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function cleanSharedState(s) {
  if (!s || typeof s !== 'object') return null;
  const perks = {};
  for (const key of ['clover', 'espresso', 'loaded_dice', 'vip_watch', 'shield_chip']) perks[key] = !!s.perks?.[key];
  return {
    balance: Math.round(clampNum(s.balance, 0, 1e9)),
    night: Math.floor(clampNum(s.night, 1, 100000)),
    currentFloor: Math.floor(clampNum(s.currentFloor, 1, 3)),
    unlockedFloors: Math.floor(clampNum(s.unlockedFloors, 1, 3)),
    target: Math.round(clampNum(s.target, 1, 1e9)),
    timeLeft: clampNum(s.timeLeft, 0, 3600),
    nightDuration: clampNum(s.nightDuration, 1, 3600),
    perks,
    shieldUsedThisNight: !!s.shieldUsedThisNight,
    hasBat: !!s.hasBat,
    state: s.state === 'GAME_OVER' ? 'GAME_OVER' : 'PLAYING'
  };
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.uid = null;
  ws.actionTimes = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const room = cleanRoom(msg.room);
      const uid = String(msg.uid || '').slice(0, 80);
      if (!room || !uid) return;
      if (ws.room) members(ws.room).delete(ws);
      ws.room = room;
      ws.uid = uid;
      if (!rooms.has(room)) rooms.set(room, new Set());
      members(room).add(ws);
      const roomInfo = dataFor(room);
      if (!roomInfo.hostUid) roomInfo.hostUid = uid;
      send(ws, { type: 'joined', room, hostUid: roomInfo.hostUid, count: members(room).size, sharedState: roomInfo.sharedState });
      for (const client of members(room)) {
        if (client !== ws && client.uid === uid) continue;
      }
      presence(room);
      return;
    }

    if (!ws.room || !ws.uid) return;
    const roomInfo = dataFor(ws.room);

    if (msg.type === 'state') {
      const p = msg.state || {};
      const state = {
        name: String(p.name || 'PLAYER').slice(0, 16),
        x: clampNum(p.x, -12, 12), z: clampNum(p.z, -10, 10),
        yaw: clampNum(p.yaw, -1000, 1000), floor: Math.floor(clampNum(p.floor, 1, 3)),
        updatedAt: Date.now()
      };
      broadcast(ws.room, { type: 'state', uid: ws.uid, state });
      return;
    }

    if (msg.type === 'worldState') {
      if (ws.uid !== roomInfo.hostUid) return;
      const s = msg.state || {};
      roomInfo.sharedState = { balance: Math.round(clampNum(s.balance, 0, 1e9)), night: Math.floor(clampNum(s.night,1,100000)), timeLeft: clampNum(s.timeLeft,0,3600), target: Math.round(clampNum(s.target,1,1e9)) };
      broadcast(ws.room, { type:'worldState', state:roomInfo.sharedState });
      return;
    }

    if (msg.type === 'visitorState') {
      if (ws.uid !== roomInfo.hostUid || !Array.isArray(msg.visitors)) return;
      const visitors = msg.visitors.slice(0, 80).map(v => ({x:clampNum(v.x,-12,12),y:clampNum(v.y,0,8),z:clampNum(v.z,-10,10),rx:clampNum(v.rx,-20,20),rz:clampNum(v.rz,-20,20),yaw:clampNum(v.yaw,-1000,1000),ragdollTimer:clampNum(v.ragdollTimer,0,5)}));
      broadcast(ws.room,{type:'visitorState',visitors});
      return;
    }

    if (msg.type === 'batSwing') {
      broadcast(ws.room,{type:'batSwing',uid:ws.uid});
      return;
    }

    if (msg.type === 'surrender') {
      broadcast(ws.room,{type:'surrender',uid:ws.uid});
      return;
    }

    if (msg.type === 'sharedState') {
      if (ws.uid !== roomInfo.hostUid) return;
      const state = cleanSharedState(msg.state);
      if (!state) return;
      roomInfo.sharedState = state;
      broadcast(ws.room, { type: 'sharedState', state });
      return;
    }

    if (msg.type === 'machineAction') {
      const now = Date.now();
      ws.actionTimes = ws.actionTimes.filter(t => now - t < 1000);
      if (ws.actionTimes.length >= ACTIONS_PER_SECOND) return;
      ws.actionTimes.push(now);
      const machineId = String(msg.machineId || '').slice(0, 80);
      const actionIndex = Number(msg.actionIndex);
      if (!/^[a-zA-Z0-9_-]+$/.test(machineId) || !Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 100) return;
      roomInfo.actionSeq++;
      // Server assigns the random seed and sequence so every client executes actions in the same order.
      broadcast(ws.room, {
        type: 'machineAction', uid: ws.uid, machineId, actionIndex,
        seed: crypto.randomBytes(4).readUInt32LE(0), seq: roomInfo.actionSeq
      });
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = ws.room;
    members(room).delete(ws);
    const stillConnected = [...members(room)].some(client => client.uid === ws.uid);
    if (!stillConnected) {
      const info = dataFor(room);
      if (info.hostUid === ws.uid) {
        const nextHost = members(room).values().next().value;
        info.hostUid = nextHost ? nextHost.uid : null;
        if (nextHost) send(nextHost, { type: 'hostChanged', hostUid: info.hostUid, sharedState: info.sharedState });
      }
    }
    if (members(room).size === 0) {
      rooms.delete(room);
      roomData.delete(room);
    } else presence(room);
  });
});

console.log(`Casino shared-state server listening on port ${PORT}`);
