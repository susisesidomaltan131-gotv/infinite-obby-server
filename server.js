
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const MAX_PLAYERS = 16;

app.get("/", (req, res) => {
    res.send("THE INFINITE OBBY SERVER ONLINE");
});

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data, except = null) {
    for (const ws of room.values()) {
        if (ws !== except) send(ws, data);
    }
}

function makeCode() {
    let code;
    do {
        code = String(crypto.randomInt(100000, 1000000));
    } while (rooms.has(code));
    return code;
}

function getRoomList() {
    return Array.from(rooms.entries()).map(([code, room]) => ({
        code,
        name: room.roomName,
        players: room.size,
        maxPlayers: MAX_PLAYERS
    }));
}

function broadcastRoomList() {
    const data = {
        type: "room_list",
        rooms: getRoomList()
    };

    for (const client of wss.clients) {
        send(client, data);
    }
}

wss.on("connection", (ws) => {
    send(ws, {
        type: "room_list",
        rooms: getRoomList()
    });

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, { type: "error", message: "Geçersiz mesaj" });
            return;
        }

        if (!data || typeof data.type !== "string") return;

        if (data.type === "list_rooms") {
            send(ws, {
                type: "room_list",
                rooms: getRoomList()
            });
            return;
        }

        if (data.type === "create") {
            if (ws.room) return;

            const roomName = String(data.roomName || "İsimsiz Oda")
                .trim()
                .slice(0, 24) || "İsimsiz Oda";

            const code = makeCode();
            const playerId = crypto.randomUUID();
            const room = new Map();

            room.roomName = roomName;
            room.set(playerId, ws);
            rooms.set(code, room);

            ws.room = code;
            ws.playerId = playerId;
            ws.nickname = "Oyuncu";

            send(ws, {
                type: "created",
                code,
                roomName,
                playerId
            });

            broadcastRoomList();
            return;
        }

        if (data.type === "join") {
            if (ws.room) return;

            const code = String(data.code || "").trim();
            const room = rooms.get(code);

            if (!/^\d{6}$/.test(code) || !room || room.size >= MAX_PLAYERS) {
                send(ws, {
                    type: "error",
                    message: "Oda bulunamadı veya dolu"
                });
                return;
            }

            const playerId = crypto.randomUUID();

            for (const [id] of room) {
                send(ws, {
                    type: "player_joined",
                    playerId: id
                });
            }

            room.set(playerId, ws);
            ws.room = code;
            ws.playerId = playerId;
            ws.nickname = "Oyuncu";

            send(ws, {
                type: "joined",
                code,
                roomName: room.roomName,
                playerId
            });

            broadcast(room, {
                type: "player_joined",
                playerId
            }, ws);

            broadcastRoomList();
            return;
        }

        if (!ws.room) {
            send(ws, {
                type: "error",
                message: "Önce bir odaya katıl"
            });
            return;
        }

        const room = rooms.get(ws.room);
        if (!room) return;

        if (data.type === "player_state") {
            const p = data.position || {};

            if (![p.x, p.y, p.z].every(Number.isFinite)) return;

            broadcast(room, {
                type: "player_state",
                playerId: ws.playerId,
                position: {
                    x: p.x,
                    y: p.y,
                    z: p.z
                }
            }, ws);
        }

        else if (data.type === "chat") {
            const message = String(data.message || "").slice(0, 160);
            if (!message.trim()) return;

            broadcast(room, {
                type: "chat",
                playerId: ws.playerId,
                nickname: ws.nickname,
                message
            });
        }

        else if (data.type === "nickname") {
            ws.nickname = String(data.nickname || "Oyuncu").slice(0, 16);
        }

        else if (data.type === "punch") {
            const target = room.get(String(data.targetId || ""));
            if (!target || target === ws) return;

            send(target, {
                type: "punch",
                playerId: ws.playerId
            });
        }
    });

    ws.on("close", () => {
        if (!ws.room) return;

        const code = ws.room;
        const room = rooms.get(code);
        if (!room) return;

        room.delete(ws.playerId);

        broadcast(room, {
            type: "player_left",
            playerId: ws.playerId
        });

        if (room.size === 0) {
            rooms.delete(code);
        }

        broadcastRoomList();
    });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
});
