const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');

// --- Initialisation ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- Middleware ---
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Connexion à MongoDB ---
// Option 1: MongoDB Atlas (gratuit, en ligne)
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://votre_user:votre_password@cluster0.xxxxx.mongodb.net/miltape?retryWrites=true&w=majority';
// Option 2: MongoDB local (si vous avez installé MongoDB sur votre téléphone/serveur)
// const MONGO_URI = 'mongodb://localhost:27017/miltape';

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connecté à MongoDB'))
.catch(err => {
  console.error('❌ Erreur MongoDB:', err.message);
  console.log('⚠️ Le serveur démarre en mode dégradé (sans base de données)');
});

// --- Modèle User (si MongoDB n'est pas disponible, on utilise une mémoire temporaire) ---
let users = [];
let totalTaps = 0;

// Schéma MongoDB si disponible
let User = null;
try {
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    walletAddress: { type: String, default: null },
    tapCount: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['tron', 'telegram'], default: 'tron' },
    lastUpdated: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  });
  User = mongoose.model('User', userSchema);
} catch (error) {
  console.log('📝 Mode mémoire activé (sans base de données)');
}

// --- Fonctions de gestion des utilisateurs (mémoire) ---
async function findUser(name) {
  if (User) {
    return await User.findOne({ name });
  }
  return users.find(u => u.name === name);
}

async function createOrUpdateUser(name, walletAddress, paymentMethod) {
  if (User) {
    const user = await User.findOneAndUpdate(
      { name },
      { walletAddress, paymentMethod },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return user;
  }
  
  let user = users.find(u => u.name === name);
  if (!user) {
    user = { name, walletAddress, paymentMethod, tapCount: 0, createdAt: new Date() };
    users.push(user);
  } else {
    user.walletAddress = walletAddress || user.walletAddress;
    user.paymentMethod = paymentMethod || user.paymentMethod;
  }
  return user;
}

async function incrementTap(name) {
  if (User) {
    const user = await User.findOneAndUpdate(
      { name },
      { $inc: { tapCount: 1 }, $set: { lastUpdated: new Date() } },
      { new: true, upsert: true }
    );
    return user;
  }
  
  let user = users.find(u => u.name === name);
  if (!user) {
    user = { name, tapCount: 1, createdAt: new Date() };
    users.push(user);
  } else {
    user.tapCount += 1;
    user.lastUpdated = new Date();
  }
  totalTaps += 1;
  return user;
}

async function getLeaderboard(limit = 10) {
  if (User) {
    return await User.find()
      .sort({ tapCount: -1 })
      .limit(limit)
      .select('name tapCount -_id');
  }
  return users
    .sort((a, b) => b.tapCount - a.tapCount)
    .slice(0, limit)
    .map(u => ({ name: u.name, tapCount: u.tapCount }));
}

async function getTotalTaps() {
  if (User) {
    const result = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$tapCount' } } }
    ]);
    return result.length > 0 ? result[0].total : 0;
  }
  return totalTaps;
}

async function getUserRank(name) {
  if (User) {
    const user = await User.findOne({ name });
    if (!user) return null;
    const count = await User.countDocuments({ tapCount: { $gt: user.tapCount } });
    return count + 1;
  }
  const sorted = [...users].sort((a, b) => b.tapCount - a.tapCount);
  const rank = sorted.findIndex(u => u.name === name);
  return rank !== -1 ? rank + 1 : null;
}

// --- Routes API ---
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: User ? 'MongoDB' : 'Memory'
  });
});

app.post('/api/users/register', async (req, res) => {
  const { name, walletAddress, paymentMethod } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Le nom est requis' });
  }
  
  try {
    const user = await createOrUpdateUser(name, walletAddress, paymentMethod);
    res.status(201).json({
      message: 'Utilisateur enregistré',
      user: {
        name: user.name,
        walletAddress: user.walletAddress,
        paymentMethod: user.paymentMethod,
        tapCount: user.tapCount,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getLeaderboard();
    res.json({ success: true, data: leaderboard });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/total-taps', async (req, res) => {
  try {
    const total = await getTotalTaps();
    res.json({ success: true, total });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log('👤 Nouvelle connexion:', socket.id);

  socket.on('get_leaderboard', async () => {
    try {
      const leaderboard = await getLeaderboard();
      socket.emit('leaderboard_update', leaderboard);
    } catch (error) {
      socket.emit('error', { message: 'Erreur classement' });
    }
  });

  socket.on('get_total_taps', async () => {
    try {
      const total = await getTotalTaps();
      socket.emit('total_taps', { total });
    } catch (error) {
      socket.emit('error', { message: 'Erreur total taps' });
    }
  });

  socket.on('user_tap', async (data) => {
    if (!data || !data.name) {
      socket.emit('error', { message: 'Données invalides' });
      return;
    }

    try {
      const user = await incrementTap(data.name);
      const leaderboard = await getLeaderboard();
      const total = await getTotalTaps();
      
      io.emit('leaderboard_update', leaderboard);
      io.emit('total_taps', { total });
      
      socket.emit('tap_confirmed', {
        name: user.name,
        tapCount: user.tapCount
      });
    } catch (error) {
      socket.emit('error', { message: 'Erreur tap' });
    }
  });

  socket.on('disconnect', () => {
    console.log('👋 Déconnexion:', socket.id);
  });
});

// --- Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Important pour le réseau local

server.listen(PORT, HOST, () => {
  console.log(`🚀 Serveur démarré sur http://${HOST}:${PORT}`);
  console.log(`📱 Connexion depuis votre téléphone: http://VOTRE_IP:${PORT}`);
  
  // Afficher l'IP locale pour le téléphone
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`📱 IP locale: http://${iface.address}:${PORT}`);
      }
    }
  }
});
