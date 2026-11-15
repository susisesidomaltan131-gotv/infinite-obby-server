
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;

const rooms = new Map();

app.get("/", (req, res) => {
    res.send("THE INFINITE OBBY SERVER ONLINE");
});

function makeCode() {
    let code;

    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(code));

    return code;
}

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

function getRoomList() {
    const result = [];

    for (const [code, room] of rooms.entries()) {
        if (room.players.size > 0) {
            result.push({
                code,
                name: room.name,
                players: room.players.size,
                maxPlayers: MAX_PLAYERS
            });
        }
    }

    return result;
}

function leaveRoom(ws) {
    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);

    if (room) {
        room.players.delete(ws.playerId);

        broadcast(room, {
            type: "player_left",
            playerId: ws.playerId
        });

        if (room.players.size === 0) {
            rooms.delete(ws.roomCode);
        } else {
            broadcast(room, {
                type: "room_list",
                rooms: getRoomList()
            });
        }
    }

    ws.roomCode = "";
    ws.playerId = "";
}

wss.on("connection", (ws) => {
    ws.playerId = Math.random().toString(36).slice(2, 10);
    ws.roomCode = "";
    ws.nickname = "Oyuncu";

    send(ws, { type: "connected" });

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, {
                type: "error",
                message: "Geçersiz mesaj."
            });
            return;
        }

        switch (data.type) {

            case "create": {
                leaveRoom(ws);

                const code = makeCode();
                const name = String(data.roomName || "İsimsiz Sunucu")
                    .trim()
                    .slice(0, 24) || "İsimsiz Sunucu";

                const room = {
                    name,
                    players: new Map()
                };

                rooms.set(code, room);

                ws.roomCode = code;
                room.players.set(ws.playerId, { ws });

                send(ws, {
                    type: "created",
                    code,
                    roomName: name,
                    playerId: ws.playerId
                });

                break;
            }

            case "list_rooms": {
                send(ws, {
                    type: "room_list",
                    rooms: getRoomList()
                });
                break;
            }

            case "join": {
                const code = String(data.code || "");
                const room = rooms.get(code);

                if (!room) {
                    send(ws, {
                        type: "error",
                        message: "Bu sunucu artık mevcut değil."
                    });
                    break;
                }

                if (room.players.size >= MAX_PLAYERS) {
                    send(ws, {
                        type: "error",
                        message: "Sunucu dolu."
                    });
                    break;
                }

                leaveRoom(ws);

                ws.roomCode = code;
                room.players.set(ws.playerId, { ws });

                send(ws, {
                    type: "joined",
                    code,
                    roomName: room.name,
                    playerId: ws.playerId
                });

                broadcast(room, {
                    type: "player_joined",
                    playerId: ws.playerId
                }, ws);

                break;
            }

            case "nickname": {
                ws.nickname = String(data.nickname || "Oyuncu").slice(0, 16);
                break;
            }

            case "player_state": {
                const room = rooms.get(ws.roomCode);
                if (!room) break;

                const p = data.position || {};

                broadcast(room, {
                    type: "player_state",
                    playerId: ws.playerId,
                    position: {
                        x: Number(p.x) || 0,
                        y: Number(p.y) || 0,
                        z: Number(p.z) || 0
                    }
                }, ws);

                break;
            }

            case "chat": {
                const room = rooms.get(ws.roomCode);
                if (!room) break;

                broadcast(room, {
                    type: "chat",
                    playerId: ws.playerId,
                    nickname: ws.nickname,
                    message: String(data.message || "").slice(0, 160)
                });

                break;
            }

            case "punch": {
                const room = rooms.get(ws.roomCode);
                if (!room) break;

                const targetId = String(data.targetId || "");
                const target = room.players.get(targetId);

                if (target) {
                    send(target.ws, {
                        type: "punch",
                        playerId: ws.playerId
                    });
                }

                break;
            }
        }
    });

    ws.on("close", () => {
        leaveRoom(ws);
    });

    ws.on("error", () => {
        leaveRoom(ws);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
