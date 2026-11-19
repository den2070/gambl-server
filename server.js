// Casino 3D multiplayer relay server
// Run: npm install && npm start
// Default port: 8080. Deploy behind HTTPS/WSS for public internet use.
const WebSocket = require('ws');
const PORT = Number(process.env.PORT || 8080);
const wss = new WebSocket.Server({ port: PORT, maxPayload: 16 * 1024 });

const rooms = new Map();
const roomStates = new Map();

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function roomMembers(room) {
  return rooms.get(room) || new Set();
}
function broadcast(room, data, except) {
  for (const client of roomMembers(room)) {
    if (client !== except) send(client, data);
  }
}
function updatePresence(room) {
  const members = roomMembers(room);
  broadcast(room, { type: 'presence', count: members.size });
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.uid = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const room = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      const uid = String(msg.uid || '').slice(0, 80);
      if (!room || !uid) return;
      if (ws.room) {
        roomMembers(ws.room).delete(ws);
        updatePresence(ws.room);
      }
      ws.room = room;
      ws.uid = uid;
      if (!rooms.has(room)) rooms.set(room, new Set());
      roomMembers(room).add(ws);
      send(ws, { type: 'joined', room, count: roomMembers(room).size });
      for (const [otherUid, state] of (roomStates.get(room) || new Map()).entries()) {
        if (otherUid !== uid) send(ws, { type: 'state', uid: otherUid, state });
      }
      broadcast(room, { type: 'presence', count: roomMembers(room).size });
      return;
    }

    if (!ws.room || !ws.uid) return;
    if (msg.type === 'state') {
      const p = msg.state || {};
      const state = {
        name: String(p.name || 'PLAYER').slice(0, 16),
        x: Number(p.x) || 0,
        z: Number(p.z) || 0,
        yaw: Number(p.yaw) || 0,
        floor: Math.max(1, Math.min(3, Number(p.floor) || 1)),
        updatedAt: Date.now()
      };
      if (!roomStates.has(ws.room)) roomStates.set(ws.room, new Map());
      roomStates.get(ws.room).set(ws.uid, state);
      broadcast(ws.room, { type: 'state', uid: ws.uid, state }, ws);
    } else if (msg.type === 'machineAction') {
      const machineId = String(msg.machineId || '').slice(0, 80);
      const actionIndex = Number(msg.actionIndex);
      const seed = Number(msg.seed) >>> 0;
      if (!machineId || !Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 100) return;
      broadcast(ws.room, { type: 'machineAction', uid: ws.uid, machineId, actionIndex, seed }, ws);
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = ws.room;
    roomMembers(room).delete(ws);
    const stillConnected = [...roomMembers(room)].some(client => client.uid === ws.uid);
    if (!stillConnected && roomStates.has(room)) roomStates.get(room).delete(ws.uid);
    if (roomMembers(room).size === 0) {
      rooms.delete(room);
      roomStates.delete(room);
    } else updatePresence(room);
  });
});

console.log(`Casino multiplayer server listening on port ${PORT}`);
