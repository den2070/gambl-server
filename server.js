const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

function getTargetForNight(nightNum) {
  const targets = [1200, 2000, 3500, 6000, 10000, 17500, 30000, 50000, 85000, 150000];
  if (nightNum <= targets.length) return targets[nightNum - 1];
  return Math.round((getTargetForNight(nightNum - 1) * 1.65) / 500) * 500;
}

function makeRoomState(roomCode) {
  const night = 1;
  return {
    code: roomCode,
    night,
    currentFloor: 1,
    unlockedFloors: 1,
    balance: 1000,
    target: getTargetForNight(night),
    timeLeft: 300,
    nightDuration: 300,
    perks: { clover: false, espresso: false, loaded_dice: false, vip_watch: false, shield_chip: false },
    shieldUsedThisNight: false,
    machineScreens: {}
  };
}

const rooms = new Map();
const clientsMeta = new Map();

function ensureRoom(roomCode) {
  const clean = String(roomCode || 'CASINO777').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'CASINO777';
  if (!rooms.has(clean)) {
    rooms.set(clean, {
      state: makeRoomState(clean),
      clients: new Set()
    });
  }
  return rooms.get(clean);
}

function broadcastRoom(roomObj, payloadObj, exceptWs = null) {
  const raw = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  for (const client of roomObj.clients) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function sendRoomState(roomObj, targetWs = null) {
  const st = roomObj.state;
  const pkt = {
    type: 'roomState',
    room: st.code,
    state: {
      night: st.night,
      currentFloor: st.currentFloor,
      unlockedFloors: st.unlockedFloors,
      balance: st.balance,
      target: st.target,
      timeLeft: Math.max(0, Math.round(st.timeLeft * 10) / 10),
      nightDuration: st.nightDuration,
      perks: st.perks,
      shieldUsedThisNight: st.shieldUsedThisNight
    },
    machineScreens: st.machineScreens
  };
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify(pkt));
  } else {
    broadcastRoom(roomObj, pkt, null);
  }
}

// Серверный тик времени ночи для комнат с игроками
setInterval(() => {
  for (const [code, roomObj] of rooms.entries()) {
    if (roomObj.clients.size === 0) {
      rooms.delete(code);
      continue;
    }
    const st = roomObj.state;
    if (st.timeLeft > 0) {
      st.timeLeft = Math.max(0, st.timeLeft - 0.5);
    }
  }
}, 500);

setInterval(() => {
  for (const roomObj of rooms.values()) {
    if (roomObj.clients.size > 0) {
      sendRoomState(roomObj, null);
    }
  }
}, 1000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'casino-3d-authoritative-server', rooms: rooms.size }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  clientsMeta.set(ws, { roomCode: null, uid: null, name: 'PLAYER' });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const meta = clientsMeta.get(ws);

    if (msg.type === 'join') {
      const roomCode = String(msg.room || 'CASINO777').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'CASINO777';
      if (meta.roomCode && rooms.has(meta.roomCode)) {
        rooms.get(meta.roomCode).clients.delete(ws);
      }
      const roomObj = ensureRoom(roomCode);
      meta.roomCode = roomCode;
      meta.uid = msg.uid || ('u_' + Math.random().toString(36).slice(2, 8));
      meta.name = String(msg.name || 'PLAYER').slice(0, 16);
      roomObj.clients.add(ws);

      ws.send(JSON.stringify({ type: 'joined', room: roomCode, playersCount: roomObj.clients.size }));
      sendRoomState(roomObj, ws);
      broadcastRoom(roomObj, { type: 'playerJoined', uid: meta.uid, name: meta.name, playersCount: roomObj.clients.size }, ws);
      return;
    }

    const roomCode = meta.roomCode || (msg.room ? String(msg.room).toUpperCase() : null);
    if (!roomCode || !rooms.has(roomCode)) return;
    const roomObj = rooms.get(roomCode);
    const st = roomObj.state;

    if (msg.type === 'resetRoom') {
      roomObj.state = makeRoomState(roomCode);
      sendRoomState(roomObj, null);
      broadcastRoom(roomObj, { type: 'roomReset', room: roomCode }, ws);
      return;
    }

    if (msg.type === 'balanceDelta') {
      let delta = Math.round(Number(msg.delta) || 0);
      if (delta < 0 && st.perks.loaded_dice) {
        delta += Math.floor(Math.abs(delta) * 0.2);
      }
      st.balance = Math.max(0, st.balance + delta);
      sendRoomState(roomObj, null);
      return;
    }

    if (msg.type === 'roundLoss') {
      const bet = Math.max(0, Math.round(Number(msg.bet) || 0));
      if (st.perks.shield_chip && !st.shieldUsedThisNight && bet > 0) {
        st.shieldUsedThisNight = true;
        st.balance += bet;
        sendRoomState(roomObj, null);
        broadcastRoom(roomObj, { type: 'shieldSaved', amount: bet, targetUid: msg.uid || meta.uid }, null);
      }
      return;
    }

    if (msg.type === 'buyPerk') {
      const perkId = String(msg.perkId || '');
      const price = Math.max(0, Math.round(Number(msg.price) || 0));
      if (perkId && Object.prototype.hasOwnProperty.call(st.perks, perkId) && !st.perks[perkId] && st.balance >= price) {
        st.balance -= price;
        st.perks[perkId] = true;
        if (perkId === 'vip_watch') {
          st.nightDuration += 45;
          st.timeLeft += 45;
        }
        sendRoomState(roomObj, null);
        broadcastRoom(roomObj, { type: 'perkBought', perkId, perkName: msg.perkName || perkId }, null);
      }
      return;
    }

    if (msg.type === 'nextNight') {
      if (st.balance >= st.target) {
        st.night += 1;
        st.shieldUsedThisNight = false;
        st.target = getTargetForNight(st.night);
        st.unlockedFloors = Math.max(st.unlockedFloors, Math.ceil(st.night / 2));
        st.nightDuration = 300 + (st.perks.vip_watch ? 45 : 0);
        st.timeLeft = st.nightDuration;
        sendRoomState(roomObj, null);
        broadcastRoom(roomObj, { type: 'nightAdvanced', night: st.night, target: st.target }, null);
      }
      return;
    }

    if (msg.type === 'floorChange') {
      const targetF = Math.max(1, Math.round(Number(msg.floor) || 1));
      if (targetF <= st.unlockedFloors) {
        st.currentFloor = targetF;
        sendRoomState(roomObj, null);
      }
      return;
    }

    if (msg.type === 'machineScreen') {
      if (msg.machineId) {
        st.machineScreens[msg.machineId] = {
          status: String(msg.status || ''),
          bet: Number(msg.bet) || 0,
          updatedAt: Date.now()
        };
      }
      broadcastRoom(roomObj, { ...msg, uid: msg.uid || meta.uid, room: roomCode }, ws);
      return;
    }

    // Движение игроков, удары по посетителям/игрокам, рэгдолл, действия на автоматах
    broadcastRoom(roomObj, {
      ...msg,
      uid: msg.uid || meta.uid,
      room: roomCode
    }, ws);
  });

  ws.on('close', () => {
    const meta = clientsMeta.get(ws);
    if (meta && meta.roomCode && rooms.has(meta.roomCode)) {
      const roomObj = rooms.get(meta.roomCode);
      roomObj.clients.delete(ws);
      broadcastRoom(roomObj, { type: 'playerLeft', uid: meta.uid, playersCount: roomObj.clients.size }, ws);
      if (roomObj.clients.size === 0) {
        rooms.delete(meta.roomCode);
      }
    }
    clientsMeta.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Casino 3D Authoritative Server listening on ws://localhost:${PORT}`);
});
