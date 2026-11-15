
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("Arena server is running"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

const GLOVES = {
  Basic: { horizontal: 9, vertical: 5.5 },
  Fire: { horizontal: 12, vertical: 7 },
  Ice: { horizontal: 9.5, vertical: 5.5 },
  Thunder: { horizontal: 16, vertical: 9 },
  Rocket: { horizontal: 21, vertical: 12 },
  Galaxy: { horizontal: 26, vertical: 15 }
};

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, except = null) {
  for (const player of room.players.values()) {
    if (player.ws !== except) {
      send(player.ws, data);
    }
  }
}

function roomList() {
  return [...rooms.entries()].map(([code, room]) => ({
    code,
    name: room.name,
    players: room.players.size,
    maxPlayers: 16
  }));
}

function leaveRoom(player) {
  if (!player.room) return;

  const room = rooms.get(player.room);

  if (room) {
    room.players.delete(player.id);

    broadcast(room, {
      type: "player_left",
      player_id: player.id
    });

    if (room.players.size === 0) {
      rooms.delete(player.room);
    }
  }

  player.room = "";
}

function joinRoom(player, code) {
  const room = rooms.get(code);

  if (!room || room.players.size >= 16) {
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

    send(player.ws, {
      type: "player_joined",
      player_id: other.id,
      nickname: other.nickname,
      position: other.position
    });

    send(other.ws, {
      type: "player_joined",
      player_id: player.id,
      nickname: player.nickname,
      position: player.position
    });
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
    a.x - b.x,
    a.y - b.y,
    a.z - b.z
  );

  if (distance > 5) return;

  const glove = isUltimate && GLOVES[data.glove]
    ? data.glove
    : "Basic";

  const force = isUltimate
    ? GLOVES[glove]
    : { horizontal: 9, vertical: 5.5 };

  const directionLength = Math.hypot(
    b.x - a.x,
    b.z - a.z
  );

  let dx = 0;
  let dz = 1;

  if (directionLength > 0.001) {
    dx = (b.x - a.x) / directionLength;
    dz = (b.z - a.z) / directionLength;
  }

  // Savurma yönü saldırandan hedefe doğrudur.
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

wss.on("connection", (ws) => {
  const player = {
    id: crypto.randomUUID(),
    ws,
    room: "",
    nickname: "Oyuncu",
    position: { x: 0, y: 1, z: 0 },
    wallet: 0,
    equipped: "normal",
    lastAttack: 0
  };

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

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
        joinRoom(player, String(data.code || ""));
        break;

      case "leave":
        leaveRoom(player);
        send(ws, { type: "left" });
        break;

      case "nickname":
        player.nickname = String(
          data.nickname || "Oyuncu"
        ).slice(0, 16);
        break;

      case "player_state": {
        if (!player.room) break;

        const p = data.position || {};

        player.position = {
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          z: Number(p.z) || 0
        };

        const currentRoom = rooms.get(player.room);

        if (currentRoom) {
          broadcast(currentRoom, {
            type: "player_state",
            player_id: player.id,
            nickname: player.nickname,
            position: player.position
          }, ws);
        }

        break;
      }

      case "chat": {
        if (!player.room) break;

        const currentRoom = rooms.get(player.room);

        if (currentRoom) {
          broadcast(currentRoom, {
            type: "chat",
            player_id: player.id,
            nickname: player.nickname,
            message: String(data.message || "").slice(0, 160)
          });
        }

        break;
      }

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
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Arena server listening on ${PORT}`);
});
