const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidV4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
const rooms = new Map(); // roomId -> { createdAt, participants: Map(socketId -> { name, mic, cam }) , messages: [] }

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { createdAt: Date.now(), participants: new Map(), messages: [], host: null });
  }
  return rooms.get(roomId);
}

// REST API
app.post('/api/rooms', (req, res) => {
  const roomId = uuidV4().replace(/-/g, '').substring(0, 10);
  const { topic, hostName } = req.body || {};
  rooms.set(roomId, {
    createdAt: Date.now(),
    topic: topic || 'Instant Meeting',
    host: hostName || null,
    participants: new Map(),
    messages: []
  });
  res.json({ roomId, link: `/room/${roomId}` });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    topic: room.topic,
    participantCount: room.participants.size,
    createdAt: room.createdAt
  });
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO signaling
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('join-room', ({ roomId, userName, avatar }) => {
    const room = getRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName || `Guest-${socket.id.slice(0,4)}`;
    socket.data.avatar = avatar || null;

    room.participants.set(socket.id, {
      id: socket.id,
      name: socket.data.userName,
      avatar: socket.data.avatar,
      mic: true,
      cam: true,
      handRaised: false,
      joinedAt: Date.now()
    });

    if (!room.host) room.host = socket.id;

    // Notify existing participants about new peer
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName: socket.data.userName,
      avatar: socket.data.avatar
    });

    // Send current participants to new user
    const participants = Array.from(room.participants.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, p]) => ({ socketId: id, ...p }));

    socket.emit('room-joined', {
      roomId,
      topic: room.topic,
      participants,
      messages: room.messages.slice(-50),
      hostId: room.host
    });

    io.to(roomId).emit('participants-updated', Array.from(room.participants.values()).map(p=>({socketId:p.id, ...p})));
    io.to(roomId).emit('system-message', { text: `${socket.data.userName} joined`, ts: Date.now() });
    console.log(`[join-room] ${socket.data.userName} -> ${roomId} (${room.participants.size})`);
  });

  // WebRTC signaling relay
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('mic-toggle', ({ micOn }) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.participants.has(socket.id)) {
      room.participants.get(socket.id).mic = micOn;
      socket.to(socket.data.roomId).emit('peer-mic-toggle', { socketId: socket.id, micOn });
      io.to(socket.data.roomId).emit('participants-updated', Array.from(room.participants.values()).map(p=>({socketId:p.id, ...p})));
    }
  });

  socket.on('cam-toggle', ({ camOn }) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.participants.has(socket.id)) {
      room.participants.get(socket.id).cam = camOn;
      socket.to(socket.data.roomId).emit('peer-cam-toggle', { socketId: socket.id, camOn });
      io.to(socket.data.roomId).emit('participants-updated', Array.from(room.participants.values()).map(p=>({socketId:p.id, ...p})));
    }
  });

  socket.on('hand-toggle', ({ raised }) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.participants.has(socket.id)) {
      room.participants.get(socket.id).handRaised = raised;
      io.to(socket.data.roomId).emit('hand-updated', { socketId: socket.id, raised });
      io.to(socket.data.roomId).emit('participants-updated', Array.from(room.participants.values()).map(p=>({socketId:p.id, ...p})));
    }
  });

  socket.on('reaction', ({ emoji }) => {
    io.to(socket.data.roomId).emit('reaction', { socketId: socket.id, userName: socket.data.userName, emoji, ts: Date.now() });
  });

  socket.on('chat-message', ({ text }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const msg = { id: Date.now() + '-' + socket.id, senderId: socket.id, senderName: socket.data.userName, text, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(socket.data.roomId).emit('chat-message', msg);
  });

  socket.on('screen-share-started', () => {
    socket.to(socket.data.roomId).emit('peer-screen-share', { socketId: socket.id, sharing: true });
  });
  socket.on('screen-share-stopped', () => {
    socket.to(socket.data.roomId).emit('peer-screen-share', { socketId: socket.id, sharing: false });
  });

  socket.on('leave-room', () => handleLeave(socket));

  socket.on('disconnect', () => handleLeave(socket));
});

function handleLeave(socket) {
  const roomId = socket.data.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  const name = socket.data.userName || 'Guest';
  room.participants.delete(socket.id);

  socket.to(roomId).emit('user-left', { socketId: socket.id, userName: name });
  io.to(roomId).emit('participants-updated', Array.from(room.participants.values()).map(p=>({socketId:p.id, ...p})));
  io.to(roomId).emit('system-message', { text: `${name} left`, ts: Date.now() });

  // Host reassignment
  if (room.host === socket.id && room.participants.size > 0) {
    room.host = room.participants.keys().next().value;
    io.to(roomId).emit('host-changed', { hostId: room.host });
  }

  // Cleanup empty room after 5 min
  if (room.participants.size === 0) {
    setTimeout(() => {
      if (rooms.has(roomId) && rooms.get(roomId).participants.size === 0) {
        rooms.delete(roomId);
        console.log(`[cleanup] room ${roomId} deleted`);
      }
    }, 5 * 60 * 1000);
  }
  console.log(`[leave] ${name} left ${roomId} (${room.participants.size} remaining)`);
}

server.listen(PORT, () => {
  console.log(`✓ Meeting App running at http://localhost:${PORT}`);
});
