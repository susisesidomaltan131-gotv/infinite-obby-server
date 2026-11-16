
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("THE INFINITE FIGHT server is running"));

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  maxPayload: 16 * 1024
});

const rooms = new Map();
const MAX_PLAYERS = 16;

const GLOVES = {
  Basic:   { horizontal: 9, vertical: 5.5 },
  Fire:    { horizontal: 12, vertical: 7 },
  Ice:     { horizontal: 9.5, vertical: 5.5 },
  Thunder: { horizontal: 16, vertical: 9 },
  Rocket:  { horizontal: 21, vertical: 12 },
  Galaxy:  { horizontal: 26, vertical: 15 }
};

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, except = null) {
  for (const player of room.players.values()) {
    if (player.ws !== except) send(player.ws, data);
  }
}

function roomList() {
  return [...rooms.entries()].map(([code, room]) => ({
    code,
    name: room.name,
    players: room.players.size,
    maxPlayers: MAX_PLAYERS
  }));
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function publicPlayerState(player) {
  return {
    type: "player_joined",
    player_id: player.id,
    nickname: player.nickname,
    position: player.position,
    rotation: player.rotation,
    glove: player.equipped,
    color: player.color,
    punch_seq: player.punch_seq,
    ultimate_seq: player.ultimate_seq,
    dash_seq: player.dash_seq
  };
}

function leaveRoom(player) {
  if (!player.room) return;

  const code = player.room;
  const room = rooms.get(code);

  if (room) {
    room.players.delete(player.id);

    broadcast(room, {
      type: "player_left",
      player_id: player.id
    });

    if (room.players.size === 0) rooms.delete(code);
  }

  player.room = "";
}

function joinRoom(player, code) {
  const room = rooms.get(code);

  if (!room || room.players.size >= MAX_PLAYERS) {
    send(player.ws, {
      type: "error",
      message: "Sunucu dolu veya bulunamadı."
    });
    return;
  }

  leaveRoom(player);

  player.room = code;
  room.players.set(player.id, player);

  send(player.ws, {
    type: "joined",
    code,
    room_name: room.name,
    player_id: player.id,
    wallet: player.wallet,
    equipped: player.equipped
  });

  for (const other of room.players.values()) {
    if (other.id === player.id) continue;

    send(player.ws, publicPlayerState(other));
    send(other.ws, publicPlayerState(player));
  }

  send(player.ws, {
    type: "wallet",
    coins: player.wallet,
    equipped: player.equipped
  });
}

function handleAttack(player, data, isUltimate) {
  if (!player.room) return;

  const now = Date.now();
  if (now - player.lastAttack < 450) return;
  player.lastAttack = now;

  const room = rooms.get(player.room);
  if (!room) return;

  const target = room.players.get(String(data.target_id || ""));
  if (!target || target.id === player.id) return;

  const a = player.position;
  const b = target.position;

  const distance = Math.hypot(
    b.x - a.x,
    b.y - a.y,
    b.z - a.z
  );

  if (distance > 5.5) return;

  const requestedGlove = String(data.glove || "");
  const glove = isUltimate &&
    GLOVES[requestedGlove] &&
    requestedGlove === player.equipped
      ? requestedGlove
      : "Basic";

  const force = isUltimate
    ? GLOVES[glove]
    : GLOVES.Basic;

  const horizontalLength = Math.hypot(
    b.x - a.x,
    b.z - a.z
  ) || 1;

  const dx = (b.x - a.x) / horizontalLength;
  const dz = (b.z - a.z) / horizontalLength;

  send(target.ws, {
    type: "knockback",
    player_id: player.id,
    target_id: target.id,
    x: dx * force.horizontal,
    y: force.vertical,
    z: dz * force.horizontal
  });

  player.wallet += isUltimate ? 10 : 5;

  send(player.ws, {
    type: "wallet",
    coins: player.wallet,
    equipped: player.equipped
  });

  if (isUltimate) {
    broadcast(room, {
      type: "ultimate_effect",
      player_id: player.id,
      target_id: target.id,
      glove
    }, player.ws);
  } else {
    broadcast(room, {
      type: "attack_effect",
      player_id: player.id,
      target_id: target.id,
      attack_type: "normal"
    }, target.ws);
  }
}

function handleVoice(player, data) {
  if (!player.room) return;

  const audio = data.audio;

  if (
    typeof audio !== "string" ||
    audio.length < 8 ||
    audio.length > 4096
  ) return;

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return;

  const now = Date.now();

  if (now - player.voiceWindowStart >= 1000) {
    player.voiceWindowStart = now;
    player.voicePackets = 0;
  }

  player.voicePackets += 1;

  if (player.voicePackets > 30) return;

  const room = rooms.get(player.room);
  if (!room) return;

  broadcast(room, {
    type: "voice",
    player_id: player.id,
    audio
  }, player.ws);
}

wss.on("connection", (ws) => {
  const player = {
    id: crypto.randomUUID(),
    ws,
    room: "",
    nickname: "Oyuncu",
    position: { x: 0, y: 1, z: 0 },
    rotation: 0,
    color: "267BED",
    equipped: "Basic",
    wallet: 0,
    punch_seq: 0,
    ultimate_seq: 0,
    dash_seq: 0,
    lastAttack: 0,
    voiceWindowStart: Date.now(),
    voicePackets: 0
  };

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "list_rooms":
        send(ws, {
          type: "room_list",
          rooms: roomList()
        });
        break;

      case "create": {
        const code = crypto.randomBytes(3)
          .toString("hex")
          .toUpperCase();

        const name = String(data.name || "Arena").slice(0, 24);

        rooms.set(code, {
          name,
          players: new Map()
        });

        joinRoom(player, code);

        send(ws, {
          type: "created",
          code,
          room_name: name
        });
        break;
      }

      case "join":
        joinRoom(
          player,
          String(data.code || "").trim().toUpperCase()
        );
        break;

      case "leave":
        leaveRoom(player);
        send(ws, { type: "left" });
        break;

      case "nickname":
        player.nickname = String(data.nickname || "Oyuncu")
          .replace(/[<>]/g, "")
          .slice(0, 16);
        break;

      case "player_state": {
        if (!player.room) break;

        const p = data.position || {};

        player.position = {
          x: cleanNumber(p.x),
          y: cleanNumber(p.y),
          z: cleanNumber(p.z)
        };

        player.rotation = cleanNumber(
          data.rotation,
          player.rotation
        );

        const glove = String(data.glove || player.equipped);

        if (Object.prototype.hasOwnProperty.call(GLOVES, glove)) {
          player.equipped = glove;
        }

        const color = String(data.color || "");

        if (/^[0-9A-Fa-f]{6,8}$/.test(color)) {
          player.color = color;
        }

        if (typeof data.nickname === "string") {
          player.nickname = data.nickname
            .replace(/[<>]/g, "")
            .slice(0, 16);
        }

        player.punch_seq = Math.max(
          0,
          Math.floor(cleanNumber(data.punch_seq, player.punch_seq))
        );

        player.ultimate_seq = Math.max(
          0,
          Math.floor(cleanNumber(data.ultimate_seq, player.ultimate_seq))
        );

        player.dash_seq = Math.max(
          0,
          Math.floor(cleanNumber(data.dash_seq, player.dash_seq))
        );

        const room = rooms.get(player.room);

        if (room) {
          broadcast(room, {
            type: "player_state",
            player_id: player.id,
            nickname: player.nickname,
            position: player.position,
            rotation: player.rotation,
            glove: player.equipped,
            color: player.color,
            punch_seq: player.punch_seq,
            ultimate_seq: player.ultimate_seq,
            dash_seq: player.dash_seq
          }, ws);
        }

        break;
      }

      case "chat": {
        if (!player.room) break;

        const room = rooms.get(player.room);

        const message = String(data.message || "")
          .replace(/[<>]/g, "")
          .trim()
          .slice(0, 160);

        if (room && message) {
          broadcast(room, {
            type: "chat",
            player_id: player.id,
            nickname: player.nickname,
            message
          });
        }

        break;
      }

      case "voice":
        handleVoice(player, data);
        break;

      case "attack":
        handleAttack(player, data, false);
        break;

      case "ultimate":
        handleAttack(player, data, true);
        break;

      case "buy_item":
      case "equip_item":
        send(ws, {
          type: "error",
          message: "Eldiven satın alma oyun içinden yönetiliyor."
        });
        break;
    }
  });

  ws.on("close", () => leaveRoom(player));
  ws.on("error", () => leaveRoom(player));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Arena server listening on ${PORT}`);
});
