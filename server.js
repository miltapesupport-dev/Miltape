const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

// Charger les variables d'environnement
dotenv.config();

// Importer les routes et modèles
const apiRoutes = require('./routes/api');
const User = require('./models/User');

// --- Initialisation ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"]
  }
});

// --- Middleware ---
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Connexion à MongoDB ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/miltape';

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connecté à MongoDB avec succès'))
.catch(err => {
  console.error('❌ Erreur de connexion à MongoDB :', err.message);
  process.exit(1);
});

// Gestion des erreurs MongoDB après connexion
mongoose.connection.on('error', err => {
  console.error('❌ Erreur MongoDB:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ Déconnecté de MongoDB');
});

// --- Routes API ---
app.use('/api', apiRoutes);

// --- Route de base ---
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Serveur Miltape en ligne'
  });
});

// --- Route 404 ---
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// --- Gestion des erreurs globales ---
app.use((err, req, res, next) => {
  console.error('❌ Erreur serveur:', err.stack);
  res.status(500).json({ 
    error: 'Erreur interne du serveur',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// --- Gestion des connexions Socket.io ---
const connectedUsers = new Map(); // Pour suivre les utilisateurs connectés

io.on('connection', (socket) => {
  console.log('👤 Nouvelle connexion Socket.io:', socket.id);

  // Événement pour récupérer le classement
  socket.on('get_leaderboard', async () => {
    try {
      const leaderboard = await User.find()
        .sort({ tapCount: -1 })
        .limit(10)
        .select('name tapCount -_id');
      socket.emit('leaderboard_update', leaderboard);
    } catch (error) {
      console.error("Erreur lors de la récupération du classement:", error);
      socket.emit('error', { 
        message: 'Impossible de récupérer le classement',
        code: 'LEADERBOARD_ERROR'
      });
    }
  });

  // Événement lorsqu'un joueur enregistre un nouveau tap
  socket.on('user_tap', async (data) => {
    if (!data || !data.name) {
      socket.emit('error', { 
        message: 'Données invalides pour user_tap',
        code: 'INVALID_DATA'
      });
      return;
    }

    try {
      // Mettre à jour le score de l'utilisateur
      const updatedUser = await User.findOneAndUpdate(
        { name: data.name },
        { 
          $inc: { tapCount: 1 },
          $set: { lastUpdated: new Date() }
        },
        { 
          new: true,
          upsert: true,
          setDefaultsOnInsert: true
        }
      );

      console.log(`⬆️ Tap pour ${updatedUser.name}, nouveau score: ${updatedUser.tapCount}`);

      // Récupérer le nouveau classement
      const newLeaderboard = await User.find()
        .sort({ tapCount: -1 })
        .limit(10)
        .select('name tapCount -_id');

      // Diffuser le nouveau classement à TOUS les clients
      io.emit('leaderboard_update', newLeaderboard);

      // Optionnel: envoyer une confirmation au joueur
      socket.emit('tap_confirmed', {
        name: updatedUser.name,
        tapCount: updatedUser.tapCount
      });

    } catch (error) {
      console.error("Erreur lors du traitement du tap:", error);
      socket.emit('error', { 
        message: 'Erreur serveur lors du tap',
        code: 'TAP_PROCESSING_ERROR'
      });
    }
  });

  // Événement pour récupérer le score d'un utilisateur spécifique
  socket.on('get_user_score', async (data) => {
    if (!data || !data.name) {
      socket.emit('error', { 
        message: 'Nom d\'utilisateur requis',
        code: 'MISSING_NAME'
      });
      return;
    }

    try {
      const user = await User.findOne({ name: data.name });
      if (user) {
        socket.emit('user_score', {
          name: user.name,
          tapCount: user.tapCount,
          rank: await User.countDocuments({ tapCount: { $gt: user.tapCount } }) + 1
        });
      } else {
        socket.emit('user_score', null);
      }
    } catch (error) {
      console.error("Erreur lors de la récupération du score:", error);
      socket.emit('error', { 
        message: 'Erreur lors de la récupération du score',
        code: 'SCORE_FETCH_ERROR'
      });
    }
  });

  // Événement pour obtenir le nombre total de taps
  socket.on('get_total_taps', async () => {
    try {
      const result = await User.aggregate([
        { $group: { _id: null, total: { $sum: '$tapCount' } } }
      ]);
      const total = result.length > 0 ? result[0].total : 0;
      socket.emit('total_taps', { total });
    } catch (error) {
      console.error("Erreur lors du calcul des taps totaux:", error);
      socket.emit('error', { 
        message: 'Erreur lors du calcul des taps totaux',
        code: 'TOTAL_TAPS_ERROR'
      });
    }
  });

  // Quand un utilisateur se déconnecte
  socket.on('disconnect', () => {
    console.log('👋 Déconnexion Socket.io:', socket.id);
  });
});

// --- Démarrage du serveur ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur en écoute sur le port ${PORT}`);
  console.log(`📡 Environnement: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Client autorisé: ${process.env.CLIENT_URL || '*'}`);
});

// --- Gestion de l'arrêt propre ---
process.on('SIGINT', () => {
  console.log('🛑 Arrêt du serveur...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('👋 Serveur arrêté proprement');
      process.exit(0);
    });
  });
});

process.on('SIGTERM', () => {
  console.log('🛑 Arrêt du serveur...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('👋 Serveur arrêté proprement');
      process.exit(0);
    });
  });
});
