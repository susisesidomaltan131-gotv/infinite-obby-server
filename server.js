const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("Arena server is running"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

const ITEMS = {
  normal: { price: 0, power: 10 },
  strong: { price: 500, power: 20 },
  fire: { price: 2000, power: 35 }
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
    maxPlayers: 16
  }));
}

function leaveRoom(player) {
  if (!player.room) return;

  const room = rooms.get(player.room);
  if (room) {
    room.players.delete(player.id);
    broadcast(room, { type: "player_left", player_id: player.id });

    if (room.players.size === 0) rooms.delete(player.room);
  }

  player.room = "";
}

function joinRoom(player, code) {
  const room = rooms.get(code);
  if (!room || room.players.size >= 16) {
    send(player.ws, { type: "error", message: "Sunucu dolu veya bulunamadı." });
    return;
  }

  leaveRoom(player);
  player.room = code;
  room.players.set(player.id, player);

  send(player.ws, {
    type: "joined",
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
        send(ws, { type: "room_list", rooms: roomList() });
        break;

      case "create": {
        const code = crypto.randomBytes(3).toString("hex").toUpperCase();
        const name = String(data.name || "Arena").slice(0, 24);

        rooms.set(code, { name, players: new Map() });
        joinRoom(player, code);

        send(ws, { type: "created", code, room_name: name });
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
        player.nickname = String(data.nickname || "Oyuncu").slice(0, 16);
        break;

      case "player_state": {
        if (!player.room) break;

        const p = data.position || {};
        player.position = {
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          z: Number(p.z) || 0
        };

        const room = rooms.get(player.room);
        if (room) {
          broadcast(room, {
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
        const room = rooms.get(player.room);
        if (room) {
          broadcast(room, {
            type: "chat",
            player_id: player.id,
            nickname: player.nickname,
            message: String(data.message || "").slice(0, 160)
          });
        }
        break;
      }

      case "attack": {
        if (!player.room) break;

        const now = Date.now();
        if (now - player.lastAttack < 450) break;
        player.lastAttack = now;

        const room = rooms.get(player.room);
        const target = room?.players.get(String(data.target_id || ""));
        if (!target || target.id === player.id) break;

        const a = player.position;
        const b = target.position;
        const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (distance > 5) break;

        const attackType = ["normal", "launch", "air_combo"].includes(data.attack_type)
          ? data.attack_type : "normal";

        const power = ITEMS[player.equipped]?.power || 10;
        const directionLength = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const dx = (b.x - a.x) / directionLength;
        const dz = (b.z - a.z) / directionLength;

        const multiplier = attackType === "launch" ? 1.8 :
          attackType === "air_combo" ? 1.3 : 1;

        send(target.ws, {
          type: "knockback",
          x: dx * power * multiplier,
          y: attackType === "launch" ? power * 1.2 : 4 + power * 0.12,
          z: dz * power * multiplier
        });

        player.wallet += attackType === "air_combo" ? 10 : 5;

        send(ws, {
          type: "wallet",
          coins: player.wallet,
          equipped: player.equipped
        });

        broadcast(room, {
          type: "attack_effect",
          player_id: player.id,
          target_id: target.id,
          attack_type: attackType
        }, target.ws);
        break;
      }

      case "buy_item": {
        const item = ITEMS[data.item];
        if (!item) break;

        if (player.wallet < item.price) {
          send(ws, { type: "error", message: "Yeterli jetonun yok." });
          break;
        }

        player.wallet -= item.price;
        player.equipped = data.item;

        send(ws, {
          type: "wallet",
          coins: player.wallet,
          equipped: player.equipped
        });
        break;
      }

      case "equip_item":
        if (ITEMS[data.item] && (data.item === "normal" || player.equipped === data.item)) {
          player.equipped = data.item;
          send(ws, {
            type: "wallet",
            coins: player.wallet,
            equipped: player.equipped
          });
        }
        break;
    }
  });

  ws.on("close", () => leaveRoom(player));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Arena server listening on ${PORT}`);
});
