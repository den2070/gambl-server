# Casino 3D multiplayer backend

## Local test
1. Install Node.js 18+.
2. In this folder run `npm install`.
3. Run `npm start`.
4. In the game's lobby, enter `ws://localhost:8080` into the WebSocket server field.
5. Open the same HTML on a second browser/computer on the same network. For another device on your LAN, use `ws://YOUR_COMPUTER_LAN_IP:8080` (allow port 8080 through your firewall).

## Public internet
Deploy `server.js` + `package.json` to a Node hosting provider that supports persistent WebSocket connections. Use its secure `wss://...` URL in the game. Do not use `ws://` for a public HTTPS-hosted game.

## Current sync scope
- Room membership and online count
- Player positions
- Machine button presses relayed to everyone in the room
- A deterministic random seed for the immediate button callback

This is a multiplayer relay prototype, not yet a fully authoritative game server. Long-running animations, timers, player balances, night progression, and anti-cheat validation are still calculated independently by each browser and can diverge. Do not use real-money payments or valuable accounts with this prototype.
