
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;

const rooms = new Map();

const ITEMS = {
    normal: { price: 0, power: 10 },
    strong: { price: 500, power: 20 },
    fire: { price: 2000, power: 35 }
};

const wallets = new Map();

app.get("/", (req, res) => {
    res.send("THE INFINITE FIGHT SERVER ONLINE");
});

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
    const result = [];

    for (const [code, room] of rooms) {
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

function refreshRoomLists() {
    const message = {
        type: "room_list",
        rooms: roomList()
    };

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && !client.roomCode) {
            send(client, message);
        }
    }
}

function makeCode() {
    let code;
    do {
        code = String(Math.floor(100000 + Math.random() * 900000));
    } while (rooms.has(code));

    return code;
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
        }
    }

    ws.roomCode = "";
    refreshRoomLists();
}

function sendWallet(ws) {
    const data = wallets.get(ws.playerId);

    if (!data) return;

    send(ws, {
        type: "wallet",
        money: data.money,
        owned: Array.from(data.owned),
        equipped: data.equipped
    });
}

function getRoom(ws) {
    return rooms.get(ws.roomCode);
}

wss.on("connection", (ws) => {
    ws.playerId = Math.random().toString(36).slice(2, 10);
    ws.roomCode = "";
    ws.nickname = "Oyuncu";
    ws.x = 0;
    ws.y = 0;
    ws.z = 0;
    ws.yaw = 0;
    ws.lastAttack = 0;
    ws.airborneUntil = 0;

    wallets.set(ws.playerId, {
        money: 0,
        owned: new Set(["normal"]),
        equipped: "normal"
    });

    send(ws, { type: "connected" });
    sendWallet(ws);

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, { type: "error", message: "Geçersiz mesaj." });
            return;
        }

        switch (data.type) {
            case "create": {
                leaveRoom(ws);

                const code = makeCode();
                const name = String(data.roomName || "Dövüş Arenası")
                    .trim().slice(0, 30) || "Dövüş Arenası";

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

                refreshRoomLists();
                break;
            }

            case "list_rooms":
                send(ws, {
                    type: "room_list",
                    rooms: roomList()
                });
                break;

            case "join": {
                const code = String(data.code || "");
                const room = rooms.get(code);

                if (!room) {
                    send(ws, { type: "error", message: "Oda bulunamadı." });
                    break;
                }

                if (room.players.size >= MAX_PLAYERS) {
                    send(ws, { type: "error", message: "Oda dolu." });
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

                for (const other of room.players.values()) {
                    if (other.ws !== ws) {
                        send(ws, {
                            type: "player_joined",
                            playerId: other.ws.playerId,
                            nickname: other.ws.nickname,
                            position: {
                                x: other.ws.x,
                                y: other.ws.y,
                                z: other.ws.z
                            },
                            yaw: other.ws.yaw
                        });
                    }
                }

                broadcast(room, {
                    type: "player_joined",
                    playerId: ws.playerId,
                    nickname: ws.nickname,
                    position: { x: ws.x, y: ws.y, z: ws.z },
                    yaw: ws.yaw
                }, ws);

                refreshRoomLists();
                sendWallet(ws);
                break;
            }

            case "leave":
                leaveRoom(ws);
                send(ws, { type: "left" });
                break;

            case "nickname":
                ws.nickname = String(data.nickname || "Oyuncu").slice(0, 20);
                break;

            case "player_state": {
                const room = getRoom(ws);
                if (!room) break;

                const p = data.position || {};

                ws.x = Number(p.x) || 0;
                ws.y = Number(p.y) || 0;
                ws.z = Number(p.z) || 0;
                ws.yaw = Number(data.yaw) || 0;

                broadcast(room, {
                    type: "player_state",
                    playerId: ws.playerId,
                    nickname: ws.nickname,
                    position: { x: ws.x, y: ws.y, z: ws.z },
                    yaw: ws.yaw
                }, ws);
                break;
            }

            case "attack": {
                const room = getRoom(ws);
                if (!room) break;

                const now = Date.now();

                if (now - ws.lastAttack < 600) break;

                const target = room.players.get(String(data.targetId || ""));
                if (!target || target.ws === ws) break;

                const victim = target.ws;
                const wallet = wallets.get(ws.playerId);
                if (!wallet) break;

                const item = ITEMS[wallet.equipped];
                if (!item) break;

                const dx = victim.x - ws.x;
                const dy = victim.y - ws.y;
                const dz = victim.z - ws.z;
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (distance > 4.0) break;

                const attackType = String(data.attackType || "normal");

                if (attackType === "air_combo" && victim.airborneUntil < now) {
                    send(ws, {
                        type: "error",
                        message: "Rakip havada değil."
                    });
                    break;
                }

                ws.lastAttack = now;

                const length = Math.max(distance, 0.01);
                const direction = {
                    x: dx / length,
                    y: 0,
                    z: dz / length
                };

                const power = item.power;

                let knockback = {
                    x: direction.x * power,
                    y: 3,
                    z: direction.z * power
                };

                if (attackType === "launch") {
                    knockback.y = power * 1.4;
                    victim.airborneUntil = now + 2500;
                } else if (attackType === "air_combo") {
                    knockback.y = power * 0.55;
                    victim.airborneUntil = now + 1000;
                }

                send(victim, {
                    type: "knockback",
                    velocity: knockback,
                    attackType,
                    attackerId: ws.playerId
                });

                broadcast(room, {
                    type: "attack_effect",
                    attackerId: ws.playerId,
                    targetId: victim.playerId,
                    attackType,
                    item: wallet.equipped
                });

                wallet.money += attackType === "air_combo" ? 10 : 5;
                sendWallet(ws);
                break;
            }

            case "buy_item": {
                const wallet = wallets.get(ws.playerId);
                const itemName = String(data.item || "");
                const item = ITEMS[itemName];

                if (!wallet || !item) break;

                if (wallet.owned.has(itemName)) {
                    send(ws, { type: "error", message: "Bu eşya zaten sende." });
                    break;
                }

                if (wallet.money < item.price) {
                    send(ws, { type: "error", message: "Yeterli paran yok." });
                    break;
                }

                wallet.money -= item.price;
                wallet.owned.add(itemName);
                wallet.equipped = itemName;

                sendWallet(ws);
                break;
            }

            case "equip_item": {
                const wallet = wallets.get(ws.playerId);
                const itemName = String(data.item || "");

                if (!wallet || !wallet.owned.has(itemName)) {
                    send(ws, { type: "error", message: "Bu eşya sende yok." });
                    break;
                }

                wallet.equipped = itemName;
                sendWallet(ws);
                break;
            }
        }
    });

    ws.on("close", () => {
        leaveRoom(ws);
        wallets.delete(ws.playerId);
    });

    ws.on("error", () => {
        leaveRoom(ws);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("THE INFINITE FIGHT running on port " + PORT);
});
