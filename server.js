const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const TICK_MS = 50; // 20 тиков в секунду
const PLAYER_HIT_COOLDOWN_MS = 5000;

const ALL_GAME_TYPES = ['slots', 'plinko', 'dice', 'blackjack', 'ducks', 'roulette', 'crash', 'wheel', 'mines', 'dragon', 'coin', 'hilo'];

const MACHINE_THEMES = {
  slots: {
    badge: 'NEON JACKPOT',
    accentColor: '#f59e0b',
    beaconHex: 0xf59e0b,
    reelCount: 4,
    reelSymbols: ['🍒', '🍋', '🔔', '💎', '7️⃣', '👑'],
    bonusMultiplier: 1.5
  },
  plinko: {
    badge: 'ICE DROP LAB',
    accentColor: '#38bdf8',
    beaconHex: 0x38bdf8,
    rows: 7,
    multiplierBoost: 1.25
  },
  dice: {
    badge: 'LUCKY 7 ARENA',
    accentColor: '#a855f7',
    beaconHex: 0xa855f7,
    sides: 6,
    sevenBonus: 6
  },
  blackjack: {
    badge: 'VIP TABLE 21',
    accentColor: '#14b8a6',
    beaconHex: 0x14b8a6,
    dealerStandAt: 17,
    blackjackPayout: 2.5
  },
  ducks: {
    badge: 'TURBO DUCK TRACK',
    accentColor: '#facc15',
    beaconHex: 0xfacc15,
    lanes: 4,
    winChance: 0.45
  },
  roulette: {
    badge: 'CRIMSON WHEEL',
    accentColor: '#ef4444',
    beaconHex: 0xef4444,
    zeroPayout: 35,
    colorPayout: 2
  },
  crash: {
    badge: 'ORBIT ROCKET',
    accentColor: '#f97316',
    beaconHex: 0xf97316,
    minCrash: 1.25,
    maxCrash: 5.5
  },
  mines: { badge: 'MINE FIELD', accentColor: '#22c55e', beaconHex: 0x22c55e },
  dragon: { badge: 'DRAGON TOWER', accentColor: '#a855f7', beaconHex: 0xa855f7 },
  coin: { badge: 'COIN FLIP', accentColor: '#fbbf24', beaconHex: 0xfbbf24 },
  hilo: { badge: 'HI-LO CARDS', accentColor: '#ec4899', beaconHex: 0xec4899 },
  wheel: {
    badge: 'MEGA FORTUNE',
    accentColor: '#eab308',
    beaconHex: 0xeab308,
    sectorsCount: 8,
    topMultiplier: 25
  }
};

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getFloorMachines(roomCode, floor) {
  const rng = mulberry32(hashSeed(`${roomCode}|floor${floor}|6machines`));
  const pool = [...ALL_GAME_TYPES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Ровно 6 автоматов на каждом этаже: два ряда по 3 с уникальными ролями и подсветкой
  const coords = [
    { x: -6.5, z: -3.6, ry: 0.2,  zone: 'WEST-FRONT',  styleMode: 'turbo-led' },
    { x: 0.0,  z: -4.2, ry: 0.0,  zone: 'CENTER-STAGE', styleMode: 'royal-crown' },
    { x: 6.5,  z: -3.6, ry: -0.2, zone: 'EAST-FRONT',  styleMode: 'pulse-ring' },
    { x: -6.5, z: 1.4,  ry: 0.35, zone: 'WEST-LOUNGE', styleMode: 'cyber-bar' },
    { x: 0.0,  z: 1.8,  ry: 0.0,  zone: 'CENTER-HUB',  styleMode: 'double-deck' },
    { x: 6.5,  z: 1.4,  ry: -0.35,zone: 'EAST-LOUNGE', styleMode: 'star-beacon' }
  ];
  return coords.map((pos, idx) => {
    const type = pool[idx % pool.length];
    const theme = MACHINE_THEMES[type] || MACHINE_THEMES.slots;
    return {
      id: `${type}_f${floor}_${idx}`,
      type,
      slotNumber: idx + 1,
      badge: theme.badge,
      theme,
      ...pos
    };
  });
}

function createServerVisitor(id, floor, rng) {
  const startX = Number(((rng() - 0.5) * 14).toFixed(2));
  const startZ = Number(((rng() - 0.5) * 10).toFixed(2));
  const v = {
    id,
    floor,
    x: startX,
    y: 0,
    z: startZ,
    startX,
    startZ,
    targetX: startX,
    targetZ: startZ,
    moveElapsed: 0,
    moveDuration: 2.0,
    vx: 0,
    vy: 0,
    vz: 0,
    ragdollTimer: 0,
    rx: 0,
    rz: 0,
    vrx: 0,
    vry: 0,
    vrz: 0,
    lastHitInfo: null
  };
  assignNewWalkTarget(v, rng);
  return v;
}

function assignNewWalkTarget(v, rng) {
  v.startX = v.x;
  v.startZ = v.z;
  v.targetX = Number((-9.2 + rng() * 18.4).toFixed(2));
  v.targetZ = Number((-6.8 + rng() * 14.0).toFixed(2));
  v.moveElapsed = 0;
  v.moveDuration = Number((1.5 + rng() * 2.5).toFixed(2)); // например 2.0 секунды
}

const rooms = new Map();

function ensureRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    const rng = mulberry32(hashSeed(`room_sim_${roomCode}`));
    const visitorsByFloor = new Map();
    for (let f = 1; f <= 6; f++) {
      visitorsByFloor.set(f, [
        createServerVisitor(1, f, rng),
        createServerVisitor(2, f, rng),
        createServerVisitor(3, f, rng),
        createServerVisitor(4, f, rng)
      ]);
    }
    rooms.set(roomCode, {
      code: roomCode,
      clients: new Set(),
      players: new Map(), // uid -> { uid, name, floor, x, y, z, yaw, hasBat, lastHitAt, updatedAt }
      rng,
      visitorsByFloor,
      economy: null // { night, balance, ... } — последняя известная общая экономика комнаты
    });
  }
  return rooms.get(roomCode);
}

function broadcastToRoom(roomCode, senderWs, payloadObj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const raw = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  for (const client of room.clients) {
    if (senderWs && client === senderWs) continue;
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function broadcastAllInRoom(roomCode, payloadObj) {
  broadcastToRoom(roomCode, null, payloadObj);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'casino-3d-authoritative-server', rooms: rooms.size }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.uid = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const roomCode = String(msg.room || 'CASINO777').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'CASINO777';
      const floor = Math.max(1, Number(msg.floor) || 1);
      const uid = msg.uid || ('u_' + Math.random().toString(36).slice(2, 8));
      ws.roomCode = roomCode;
      ws.uid = uid;

      const room = ensureRoom(roomCode);
      room.clients.add(ws);
      room.players.set(uid, {
        uid,
        name: String(msg.name || 'PLAYER').slice(0, 16),
        floor,
        x: 0,
        y: 0,
        z: 7,
        yaw: 0,
        hasBat: false,
        lastHitAt: 0,
        updatedAt: Date.now()
      });

      const machines = getFloorMachines(roomCode, floor);
      const visitors = room.visitorsByFloor.get(floor) || [];
      const initialCommands = visitors.map((v) => ({
        visitorId: v.id,
        targetX: v.targetX,
        targetY: 0,
        targetZ: v.targetZ,
        duration: v.moveDuration,
        logText: `посетитель ${v.id} идёт на ${v.targetX} 0 ${v.targetZ} ${v.moveDuration} секунд`
      }));

      ws.send(JSON.stringify({
        type: 'joined',
        room: roomCode,
        version: '2.0 RELEASE',
        floor,
        playersCount: room.clients.size,
        machinesCount: machines.length,
        machines,
        moveCommands: initialCommands,
        visitors: visitors.map((v) => ({
          id: v.id,
          x: v.x,
          y: v.y,
          z: v.z,
          vx: v.vx,
          vy: v.vy,
          vz: v.vz,
          ragdollTimer: v.ragdollTimer,
          rx: v.rx,
          rz: v.rz,
          targetX: v.targetX,
          targetZ: v.targetZ,
          moveDuration: v.moveDuration,
          moveElapsed: v.moveElapsed
        }))
      }));

      if (room.economy) {
        ws.send(JSON.stringify({ type: 'localEconomySync', room: roomCode, economy: room.economy }));
      }

      broadcastAllInRoom(roomCode, {
        type: 'presence',
        room: roomCode,
        count: room.clients.size
      });
      return;
    }

    const roomCode = ws.roomCode || (msg.room ? String(msg.room).toUpperCase() : null);
    if (!roomCode) return;
    const room = ensureRoom(roomCode);
    const uid = msg.uid || ws.uid;
    const floor = Math.max(1, Number(msg.floor) || 1);

    if (msg.type === 'state' && msg.state && typeof msg.state === 'object') {
      const prev = room.players.get(uid) || { uid, lastHitAt: 0 };
      room.players.set(uid, {
        ...prev,
        uid,
        name: String(msg.state.name || prev.name || 'PLAYER').slice(0, 16),
        floor: Math.max(1, Number(msg.state.floor) || prev.floor || 1),
        x: Number(msg.state.x) || 0,
        y: Number(msg.state.y) || 0,
        z: Number(msg.state.z) || 0,
        vy: Number(msg.state.vy) || 0,
        jumping: !!msg.state.jumping || (Number(msg.state.y) || 0) > 0.05,
        yaw: Number(msg.state.yaw) || 0,
        hasBat: !!msg.state.hasBat,
        updatedAt: Date.now()
      });
      broadcastToRoom(roomCode, ws, {
        type: 'state',
        uid,
        room: roomCode,
        state: msg.state
      });
      return;
    }

    if (msg.type === 'playerJump') {
      const prev = room.players.get(uid) || { uid, lastHitAt: 0 };
      const jx = Number.isFinite(Number(msg.x)) ? Number(msg.x) : (prev.x || 0);
      const jy = Math.max(0.05, Number(msg.y) || 0.12);
      const jz = Number.isFinite(Number(msg.z)) ? Number(msg.z) : (prev.z || 0);
      const jvy = Number(msg.vy) || 6.4;
      room.players.set(uid, {
        ...prev,
        uid,
        floor,
        x: jx,
        y: jy,
        z: jz,
        vy: jvy,
        jumping: true,
        updatedAt: Date.now()
      });
      broadcastToRoom(roomCode, ws, {
        type: 'playerJump',
        room: roomCode,
        uid,
        floor,
        x: jx,
        y: jy,
        z: jz,
        vy: jvy
      });
      return;
    }

    // Регдолл между игроками с проверкой кулдауна 5 секунд и расчётом полёта fall from ... to ...
    if (msg.type === 'playerRagdoll') {
      const now = Date.now();
      const attacker = room.players.get(uid) || { uid, lastHitAt: 0, x: 0, y: 0, z: 0 };
      if (now - (attacker.lastHitAt || 0) < PLAYER_HIT_COOLDOWN_MS) {
        const leftSec = ((PLAYER_HIT_COOLDOWN_MS - (now - attacker.lastHitAt)) / 1000).toFixed(1);
        ws.send(JSON.stringify({
          type: 'chat',
          room: roomCode,
          sender: 'СЕРВЕР',
          text: `Кулдаун удара по игроку: осталось ${leftSec} сек.`
        }));
        return;
      }
      attacker.lastHitAt = now;
      room.players.set(uid, attacker);

      const targetUid = msg.targetUid || null;
      const targetPlayer = targetUid ? room.players.get(targetUid) : null;
      const startX = Number.isFinite(Number(msg.startX)) ? Number(msg.startX) : Number(targetPlayer?.x ?? attacker.x ?? 0);
      const startY = Number.isFinite(Number(msg.startY)) ? Number(msg.startY) : Number(targetPlayer?.y ?? 0);
      const startZ = Number.isFinite(Number(msg.startZ)) ? Number(msg.startZ) : Number(targetPlayer?.z ?? attacker.z ?? 0);

      let vx = Number(msg.vx);
      let vy = Number(msg.vy);
      let vz = Number(msg.vz);
      if (!Number.isFinite(vx) || !Number.isFinite(vz)) {
        const dx = (Number(msg.endX) || startX + 2) - startX;
        const dz = (Number(msg.endZ) || startZ + 2) - startZ;
        const len = Math.max(0.001, Math.hypot(dx, dz));
        vx = (dx / len) * 9.6;
        vz = (dz / len) * 9.6;
      }
      if (!Number.isFinite(vy)) vy = 5.4;

      const horizDist = Math.hypot(vx, vz) * 0.42;
      const dirLen = Math.max(0.001, Math.hypot(vx, vz));
      const endX = Number.isFinite(Number(msg.endX))
        ? Number(Math.max(-10.2, Math.min(10.2, Number(msg.endX))).toFixed(2))
        : Number(Math.max(-10.2, Math.min(10.2, startX + (vx / dirLen) * horizDist)).toFixed(2));
      const endY = Number.isFinite(Number(msg.endY))
        ? Number(Math.max(0, Number(msg.endY)).toFixed(2))
        : Number(Math.max(0.4, (vy * vy) / (2 * 15.5)).toFixed(2));
      const endZ = Number.isFinite(Number(msg.endZ))
        ? Number(Math.max(-8.2, Math.min(8.2, Number(msg.endZ))).toFixed(2))
        : Number(Math.max(-8.2, Math.min(8.2, startZ + (vz / dirLen) * horizDist)).toFixed(2));

      const fallSummary = `fall from ${startX.toFixed(2)} ${startY.toFixed(2)} ${startZ.toFixed(2)} to ${endX.toFixed(2)} ${endY.toFixed(2)} ${endZ.toFixed(2)}`;
      const eventId = msg.eventId || `rag_${now}_${Math.random().toString(36).slice(2, 6)}`;

      const payload = {
        type: 'playerRagdoll',
        room: roomCode,
        uid,
        targetUid,
        floor,
        eventId,
        startX: Number(startX.toFixed(2)),
        startY: Number(startY.toFixed(2)),
        startZ: Number(startZ.toFixed(2)),
        endX,
        endY,
        endZ,
        vx: Number(vx.toFixed(2)),
        vy: Number(vy.toFixed(2)),
        vz: Number(vz.toFixed(2)),
        duration: Number(msg.duration) || 1.35,
        fallSummary
      };

      broadcastAllInRoom(roomCode, payload);
      return;
    }

    if (msg.type === 'chat') {
      const cleanText = String(msg.text || '').trim().slice(0, 140);
      if (!cleanText) return;
      broadcastToRoom(roomCode, ws, {
        type: 'chat',
        room: roomCode,
        uid,
        sender: String(msg.sender || 'ИГРОК').slice(0, 16),
        text: cleanText
      });
      return;
    }

    if (msg.type === 'machineAction') {
      broadcastToRoom(roomCode, ws, {
        type: 'machineAction',
        room: roomCode,
        uid,
        floor,
        machineId: msg.machineId,
        actionIndex: Number(msg.actionIndex) || 0,
        seed: Number(msg.seed) >>> 0
      });
      return;
    }

    if (msg.type === 'requestFloorState') {
      if (!room.visitorsByFloor.has(floor)) {
        room.visitorsByFloor.set(floor, [
          createServerVisitor(1, floor, room.rng),
          createServerVisitor(2, floor, room.rng),
          createServerVisitor(3, floor, room.rng),
          createServerVisitor(4, floor, room.rng)
        ]);
      }
      const floorVisitors = room.visitorsByFloor.get(floor) || [];
      ws.send(JSON.stringify({
        type: 'floorState',
        room: roomCode,
        floor,
        machines: getFloorMachines(roomCode, floor),
        moveCommands: floorVisitors.map((v) => ({
          visitorId: v.id,
          targetX: v.targetX,
          targetY: 0,
          targetZ: v.targetZ,
          duration: v.moveDuration,
          logText: `посетитель ${v.id} идёт на ${v.targetX} 0 ${v.targetZ} ${v.moveDuration} секунд`
        })),
        visitors: floorVisitors
      }));
      return;
    }

    // Удар по посетителю обрабатывается сервером: фиксируется секунда движения и угол удара в градусах
    if (msg.type === 'visitorHit') {
      const visitors = room.visitorsByFloor.get(floor) || [];
      const idx = Number(msg.visitorIndex);
      const v = visitors[idx];
      if (!v) return;

      const hitAtSec = Number(v.moveElapsed.toFixed(2));
      const angleDeg = Number.isFinite(Number(msg.angleDeg))
        ? Math.round(((Number(msg.angleDeg) % 360) + 360) % 360)
        : Math.round((Math.atan2(Number(msg.vx) || 0, Number(msg.vz) || 1) * 180) / Math.PI);
      const angleRad = (angleDeg * Math.PI) / 180;
      const power = 8.4;

      v.ragdollTimer = 2.0;
      v.y = Math.max(0.1, v.y);
      v.vx = Number((Math.sin(angleRad) * power).toFixed(2));
      v.vz = Number((Math.cos(angleRad) * power).toFixed(2));
      v.vy = 5.0;
      v.vrx = Number(((room.rng() - 0.5) * 9).toFixed(2));
      v.vry = Number(((room.rng() - 0.5) * 12).toFixed(2));
      v.vrz = Number(((room.rng() - 0.5) * 9).toFixed(2));
      v.lastHitInfo = {
        visitorId: v.id,
        second: hitAtSec,
        angleDeg
      };

      const eventId = msg.eventId || `srv_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      broadcastAllInRoom(roomCode, {
        type: 'visitorHit',
        room: roomCode,
        floor,
        visitorIndex: idx,
        visitorId: v.id,
        eventId,
        second: hitAtSec,
        angleDeg,
        vx: v.vx,
        vz: v.vz,
        vy: v.vy,
        vrx: v.vrx,
        vry: v.vry,
        vrz: v.vrz,
        logText: `посетитель ${v.id} ударен на ${hitAtSec} сек в направлении ${angleDeg} градусов`
      });
      return;
    }

    // Общая экономика: сервер помнит ночь комнаты и отбрасывает устаревшие пакеты,
    // иначе отстающий клиент откатывает всех обратно на прошлую ночь.
    if (['localEconomySync', 'localEconomyDelta', 'nightAdvance', 'localEconomyReset'].includes(msg.type) && msg.economy) {
      const curNight = room.economy ? Number(room.economy.night) || 1 : 0;
      if (msg.type !== 'localEconomyReset' && Number(msg.economy.night) < curNight) return;
      room.economy = { ...msg.economy };
    }

    broadcastToRoom(roomCode, ws, {
      ...msg,
      uid: msg.uid || ws.uid,
      room: roomCode
    });
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms.has(ws.roomCode)) {
      const room = rooms.get(ws.roomCode);
      room.clients.delete(ws);
      if (ws.uid) room.players.delete(ws.uid);
      broadcastAllInRoom(ws.roomCode, {
        type: 'presence',
        room: ws.roomCode,
        count: room.clients.size
      });
      if (room.clients.size === 0) rooms.delete(ws.roomCode);
    }
  });
});

// Серверный тик движения посетителей и рассылки маршрутов/состояний
setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const [roomCode, room] of rooms.entries()) {
    if (room.clients.size === 0) continue;

    for (const [floor, visitors] of room.visitorsByFloor.entries()) {
      const moveCommands = [];

      for (const v of visitors) {
        if (v.ragdollTimer > 0) {
          v.ragdollTimer = Math.max(0, Number((v.ragdollTimer - dt).toFixed(3)));
          v.vy -= 16.5 * dt;
          v.x = Math.max(-10.5, Math.min(10.5, v.x + v.vx * dt));
          v.y += v.vy * dt;
          v.z = Math.max(-8.2, Math.min(8.2, v.z + v.vz * dt));
          v.rx += v.vrx * dt;
          v.rz += v.vrz * dt;
          if (v.y <= 0.35 && v.vy < 0) {
            v.y = 0.35;
            v.vy = -v.vy * 0.42;
            v.vx *= 0.78;
            v.vz *= 0.78;
          }
          if (v.ragdollTimer === 0) {
            v.y = 0;
            v.rx = 0;
            v.rz = 0;
            v.vx = 0;
            v.vy = 0;
            v.vz = 0;
            assignNewWalkTarget(v, room.rng);
            moveCommands.push({
              visitorId: v.id,
              targetX: v.targetX,
              targetY: 0,
              targetZ: v.targetZ,
              duration: v.moveDuration,
              logText: `посетитель ${v.id} идёт на ${v.targetX} 0 ${v.targetZ} ${v.moveDuration} секунд`
            });
          }
        } else {
          v.moveElapsed = Number((v.moveElapsed + dt).toFixed(3));
          const progress = Math.min(1, v.moveElapsed / Math.max(0.1, v.moveDuration));
          const prevX = v.x;
          const prevZ = v.z;
          v.x = Number((v.startX + (v.targetX - v.startX) * progress).toFixed(2));
          v.z = Number((v.startZ + (v.targetZ - v.startZ) * progress).toFixed(2));
          v.vx = Number(((v.x - prevX) / dt).toFixed(2));
          v.vz = Number(((v.z - prevZ) / dt).toFixed(2));
          v.y = 0;

          if (progress >= 1) {
            assignNewWalkTarget(v, room.rng);
            moveCommands.push({
              visitorId: v.id,
              targetX: v.targetX,
              targetY: 0,
              targetZ: v.targetZ,
              duration: v.moveDuration,
              logText: `посетитель ${v.id} идёт на ${v.targetX} 0 ${v.targetZ} ${v.moveDuration} секунд`
            });
          }
        }
      }

      broadcastAllInRoom(roomCode, {
        type: 'visitorSnapshot',
        room: roomCode,
        floor,
        moveCommands,
        visitors: visitors.map((v) => ({
          id: v.id,
          x: v.x,
          y: v.y,
          z: v.z,
          vx: v.vx,
          vy: v.vy,
          vz: v.vz,
          ragdollTimer: v.ragdollTimer,
          rx: v.rx,
          rz: v.rz,
          targetX: v.targetX,
          targetZ: v.targetZ,
          moveDuration: v.moveDuration,
          moveElapsed: v.moveElapsed
        }))
      });
    }
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Casino 3D authoritative server listening on ws://localhost:${PORT}`);
});
