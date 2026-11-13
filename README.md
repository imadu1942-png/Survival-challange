# Survival Challenge: online server

Files (keep all four in the SAME folder, no subfolders): `server.js`, `index.html`, `package.json`, `README.md`.

The server serves the game page AND the WebSocket. Open the game from the server URL, not from claude.ai.
(Pages on claude.ai cannot connect to outside servers or use the mic, so offline play still works there but online play does not.)

## Deploy from an Android phone (free)
1. Create a free account at github.com. Tap + > New repository (name: survival-challenge, Public).
2. In the repo tap Add file > Upload files. Pick the 3 files: server.js, index.html, package.json. Commit.
3. Create a free account at render.com (sign in with GitHub).
4. New > Web Service > pick your survival-challenge repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   - Optional environment variable: MAX_PLAYERS = 8 (maximum players per room, default 16)
5. Deploy. Render gives you an https:// URL. Open it on your phone and your friends' phones.

## Play
Main menu > CREATE ROOM > ENABLE MIC > SHARE INVITE. Friends open the link (or JOIN ROOM + the 5-letter code).
Host sets capacity with - / +. START needs the room full, so lower the capacity to the number of players present.

## Needs / limits
- No database, API key or private secret is used. Nothing is stored: rooms live in server memory, voice is never recorded.
- Free Render services sleep after ~15 min idle (first load ~1 minute) and restart clears all rooms.
- Voice is a peer-to-peer WebRTC mesh with Google STUN. Fine for about 6-8 voices. Strict networks (some mobile carriers/offices) need a TURN server: add one to `ICE` in index.html (TURN credentials are visible to players, use a provider's short-lived credentials).
- Real capacity depends on the plan; raise MAX_PLAYERS only after load testing. 16+ voices needs an SFU service (e.g. LiveKit).
