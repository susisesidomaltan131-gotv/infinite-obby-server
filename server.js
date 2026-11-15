
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

function makeCode() {
    let code;
    do {
        code = String(crypto.randomInt(100000, 1000000));
    } while (rooms.has(code));
    return code;
}

wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, { type: "error", message: "Geçersiz mesaj" });
            return;
        }

        if (data.type === "create") {
            if (ws.room) return;

            const code = makeCode();
            const playerId = crypto.randomUUID();

            rooms.set(code, new Map([[playerId, ws]]));
            ws.room = code;
            ws.playerId = playerId;

            send(ws, { type: "created", code, playerId });
        }

        else if (data.type === "join") {
            if (ws.room) return;

            const code = String(data.code || "");
            const room = rooms.get(code);

            if (!/^\d{6}$/.test(code) || !room || room.size >= MAX_PLAYERS) {
                send(ws, { type: "error", message: "Oda bulunamadı veya dolu" });
                return;
            }

            const playerId = crypto.randomUUID();
            room.set(playerId, ws);

            ws.room = code;
            ws.playerId = playerId;

            send(ws, { type: "joined", code, playerId });

            for (const [id, player] of room) {
                if (id !== playerId) {
                    send(player, { type: "player_joined", playerId });
                }
            }
        }

        else if (data.type === "player_state" && ws.room) {
            const room = rooms.get(ws.room);
            if (!room) return;

            for (const [id, player] of room) {
                if (id !== ws.playerId) {
                    send(player, {
                        type: "player_state",
                        playerId: ws.playerId,
                        position: data.position,
                        rotation: data.rotation
                    });
                }
            }
        }
    });

    ws.on("close", () => {
        if (!ws.room) return;

        const room = rooms.get(ws.room);
        if (!room) return;

        room.delete(ws.playerId);

        for (const player of room.values()) {
            send(player, {
                type: "player_left",
                playerId: ws.playerId
            });
        }

        if (room.size === 0) rooms.delete(ws.room);
    });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT);
});
