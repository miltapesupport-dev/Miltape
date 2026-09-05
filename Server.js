const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(__dirname));

// Stockage en mémoire (pas besoin de MongoDB)
let users = [];
let totalTaps = 0;

function findUser(name) {
  return users.find(u => u.name === name);
}

function createUser(name, wallet) {
  const user = { name, wallet, tapCount: 0 };
  users.push(user);
  return user;
}

function incrementTap(name) {
  let user = findUser(name);
  if (!user) user = createUser(name);
  user.tapCount += 1;
  totalTaps += 1;
  return user;
}

function getLeaderboard() {
  return users
    .sort((a, b) => b.tapCount - a.tapCount)
    .slice(0, 10)
    .map(u => ({ name: u.name, tapCount: u.tapCount }));
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/register', (req, res) => {
  const { name, wallet } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  let user = findUser(name);
  if (!user) user = createUser(name, wallet);
  res.json({ success: true, user: { name: user.name, tapCount: user.tapCount } });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ data: getLeaderboard() });
});

app.get('/api/total-taps', (req, res) => {
  res.json({ total: totalTaps });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('👤 Joueur connecté');

  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard_update', getLeaderboard());
  });

  socket.on('get_total_taps', () => {
    socket.emit('total_taps', { total: totalTaps });
  });

  socket.on('user_tap', (data) => {
    if (!data || !data.name) return;
    const user = incrementTap(data.name);
    const leaderboard = getLeaderboard();
    io.emit('leaderboard_update', leaderboard);
    io.emit('total_taps', { total: totalTaps });
    socket.emit('tap_confirmed', { name: user.name, tapCount: user.tapCount });
  });

  socket.on('disconnect', () => {
    console.log('👋 Joueur déconnecté');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📱 http://localhost:${PORT}`);
});
