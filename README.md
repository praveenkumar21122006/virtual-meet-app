# Meetly — Meeting App

Reliable, feature-rich virtual meeting platform for remote collaboration. Built with **WebRTC (P2P mesh) + Socket.IO signaling + Express**.

## Features
- **Instant meetings** — create room in 1 click, shareable link + code (`/room/:id`)
- **HD video & audio** — WebRTC with STUN, echo cancellation, noise suppression, auto gain
- **Lobby preview** — toggle mic/cam before joining
- **In-meeting controls** — mute, camera, screen share, hand raise, leave
- **Responsive video grid** — Grid / Spotlight layout, speaking highlight, cam/mic badges
- **Screen sharing** — `getDisplayMedia` with track replacement for all peers
- **Chat + reactions** — ephemeral messages (kept in-memory), emoji fly animations
- **Participants** — live list, hand raise, host crown, count
- **Invite** — copy link anywhere, recent meetings (localStorage)
- **Timer & presence** — live duration, system join/leave messages

## Stack
- Backend: Node.js, Express, Socket.IO, UUID
- Frontend: Vanilla HTML/CSS/JS (no build), modern dark UI
- Signaling: Socket.IO relay for SDP + ICE
- P2P: mesh `RTCPeerConnection` per peer

## Run
```bash
npm install
npm start
# -> http://localhost:3000
```

## API
- `POST /api/rooms` `{ topic?, hostName? }` → `{ roomId, link }`
- `GET /api/rooms/:roomId` → `{ exists, topic, participantCount }`
- `GET /room/:roomId` → app (deep link to lobby)

## Socket Events
`join-room`, `signal`, `mic-toggle`, `cam-toggle`, `hand-toggle`, `reaction`, `chat-message`, `screen-share-*`, `leave-room`

## Notes
- Rooms are ephemeral (in-memory); empty rooms auto-delete after 5 min.
- Mesh scales well to ~8-12 peers; for larger, add SFU (mediasoup/Janus).
