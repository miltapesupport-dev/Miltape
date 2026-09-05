require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const TronWeb = require('tronweb');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Middleware ---
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting (protection contre les attaques)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessayez plus tard' }
});
app.use('/api/', limiter);

// --- MongoDB ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/miltape';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connecté à MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB:', err.message);
    console.log('⚠️ Mode mémoire activé');
  });

// --- Modèles ---
let User = null;
let Transaction = null;

try {
  // Modèle Utilisateur
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    email: { type: String, trim: true, sparse: true },
    password: { type: String },
    walletAddress: { type: String, default: null },
    tapCount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['tron', 'telegram', 'free'], default: 'free' },
    isPaid: { type: Boolean, default: false },
    paymentVerified: { type: Boolean, default: false },
    subscription: {
      type: String,
      enum: ['free', 'basic', 'premium', 'vip'],
      default: 'free'
    },
    subscriptionExpiry: { type: Date, default: null },
    referralCode: { type: String, unique: true, sparse: true },
    referralCount: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  });
  
  // Modèle Transaction
  const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USDT' },
    walletAddress: { type: String },
    transactionHash: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'pending' },
    paymentMethod: { type: String, enum: ['tron', 'telegram'], required: true },
    createdAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date }
  });
  
  User = mongoose.model('User', userSchema);
  Transaction = mongoose.model('Transaction', transactionSchema);
} catch (error) {
  console.log('📝 Mode mémoire activé');
}

// --- Configuration TRON ---
const tronWeb = new TronWeb({
  fullHost: process.env.TRON_NETWORK || 'https://api.trongrid.io',
  privateKey: process.env.TRON_PRIVATE_KEY
});

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT TRC20

// --- Stockage mémoire (fallback) ---
let users = [];
let transactions = [];
let totalTaps = 0;
let isMemoryMode = false;

// --- Fonctions de base ---
async function findUser(name) {
  if (User) return await User.findOne({ name });
  return users.find(u => u.name === name);
}

async function createUser(name, wallet, password) {
  if (User) {
    const user = new User({ name, walletAddress: wallet, password });
    await user.save();
    return user;
  }
  const user = { name, walletAddress: wallet, tapCount: 0, isPaid: false, subscription: 'free' };
  users.push(user);
  return user;
}

async function updateUser(name, data) {
  if (User) {
    return await User.findOneAndUpdate({ name }, data, { new: true });
  }
  const user = users.find(u => u.name === name);
  if (user) Object.assign(user, data);
  return user;
}

async function incrementTap(name) {
  if (User) {
    const user = await User.findOneAndUpdate(
      { name },
      { $inc: { tapCount: 1 }, $set: { lastActive: new Date() } },
      { new: true, upsert: true }
    );
    return user;
  }
  let user = users.find(u => u.name === name);
  if (!user) {
    user = { name, tapCount: 1, isPaid: false, subscription: 'free' };
    users.push(user);
  } else {
    user.tapCount += 1;
  }
  totalTaps += 1;
  return user;
}

async function getLeaderboard(limit = 10) {
  if (User) {
    return await User.find()
      .sort({ tapCount: -1 })
      .limit(limit)
      .select('name tapCount subscription -_id');
  }
  return users
    .sort((a, b) => b.tapCount - a.tapCount)
    .slice(0, limit)
    .map(u => ({ name: u.name, tapCount: u.tapCount, subscription: u.subscription }));
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

// --- Fonctions de paiement ---

// Prix en USDT
const PRICES = {
  basic: 1.99,
  premium: 4.99,
  vip: 9.99
};

// Créer une transaction
async function createTransaction(userName, amount, method, walletAddress) {
  const txData = {
    userName,
    amount,
    paymentMethod: method,
    walletAddress: walletAddress || WALLET_ADDRESS,
    status: 'pending'
  };
  
  if (Transaction) {
    const tx = new Transaction(txData);
    await tx.save();
    return tx;
  }
  const tx = { ...txData, _id: transactions.length + 1, createdAt: new Date() };
  transactions.push(tx);
  return tx;
}

// Vérifier une transaction TRON
async function verifyTronTransaction(txHash, expectedAmount) {
  try {
    const tx = await tronWeb.trx.getTransactionInfo(txHash);
    if (!tx || !tx.receipt || tx.receipt.result !== 'SUCCESS') {
      return { success: false, message: 'Transaction non confirmée' };
    }
    
    // Vérifier le montant (en USDT)
    const amount = tx.receipt.energy_usage || 0;
    if (amount < expectedAmount * 1000000) {
      return { success: false, message: 'Montant insuffisant' };
    }
    
    return { success: true, amount };
  } catch (error) {
    return { success: false, message: 'Erreur de vérification: ' + error.message };
  }
}

// Confirmer un paiement
async function confirmPayment(userName, txHash, amount) {
  const user = await findUser(userName);
  if (!user) return { success: false, message: 'Utilisateur non trouvé' };
  
  // Déterminer le niveau d'abonnement
  let subscription = 'basic';
  if (amount >= 9.99) subscription = 'vip';
  else if (amount >= 4.99) subscription = 'premium';
  
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + 1); // 1 mois d'abonnement
  
  await updateUser(userName, {
    isPaid: true,
    paidAmount: amount,
    subscription: subscription,
    subscriptionExpiry: expiry,
    paymentVerified: true
  });
  
  // Mettre à jour la transaction
  if (Transaction) {
    await Transaction.findOneAndUpdate(
      { transactionHash: txHash },
      { status: 'confirmed', confirmedAt: new Date() }
    );
  }
  
  return { success: true, subscription };
}

// Générer un code de parrainage
function generateReferralCode(name) {
  return name.substring(0, 3).toUpperCase() + 
         Math.random().toString(36).substring(2, 7).toUpperCase();
}

// --- Routes API ---

// Route publique
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: User ? 'MongoDB' : 'Memory',
    users: User ? null : users.length
  });
});

// --- Routes d'inscription ---
app.post('/api/register', async (req, res) => {
  const { name, wallet, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  
  try {
    let user = await findUser(name);
    if (!user) {
      user = await createUser(name, wallet, password);
      // Générer code parrainage
      const code = generateReferralCode(name);
      await updateUser(name, { referralCode: code });
    }
    res.json({ success: true, user: { name: user.name, tapCount: user.tapCount, isPaid: user.isPaid || false, subscription: user.subscription || 'free' } });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --- Routes de paiement ---
app.post('/api/payment/initiate', async (req, res) => {
  const { userName, amount, method, walletAddress } = req.body;
  if (!userName || !amount || !method) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  
  try {
    const tx = await createTransaction(userName, amount, method, walletAddress);
    res.json({
      success: true,
      transaction: tx,
      walletAddress: WALLET_ADDRESS,
      amount: amount,
      currency: 'USDT'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur de transaction' });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  const { userName, txHash, amount } = req.body;
  if (!userName || !txHash) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  
  try {
    const verification = await verifyTronTransaction(txHash, amount);
    if (!verification.success) {
      return res.status(400).json({ error: verification.message });
    }
    
    const result = await confirmPayment(userName, txHash, amount);
    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }
    
    // Diffuser la mise à jour du classement
    const leaderboard = await getLeaderboard();
    io.emit('leaderboard_update', leaderboard);
    
    res.json({ 
      success: true, 
      subscription: result.subscription,
      message: 'Paiement confirmé !'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur de vérification' });
  }
});

// --- Routes de jeu ---
app.get('/api/leaderboard', async (req, res) => {
  try {
    const data = await getLeaderboard();
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/api/total-taps', async (req, res) => {
  try {
    const total = await getTotalTaps();
    res.json({ total });
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/api/user/:name', async (req, res) => {
  try {
    const user = await findUser(req.params.name);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({
      name: user.name,
      tapCount: user.tapCount,
      isPaid: user.isPaid || false,
      subscription: user.subscription || 'free',
      paidAmount: user.paidAmount || 0,
      referralCode: user.referralCode,
      referralCount: user.referralCount || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log('👤 Nouveau joueur');

  socket.on('get_leaderboard', async () => {
    const data = await getLeaderboard();
    socket.emit('leaderboard_update', data);
  });

  socket.on('get_total_taps', async () => {
    const total = await getTotalTaps();
    socket.emit('total_taps', { total });
  });

  socket.on('user_tap', async (data) => {
    if (!data || !data.name) return;
    
    const user = await findUser(data.name);
    // Vérifier si l'utilisateur a le droit de jouer (payant ou mode gratuit limité)
    if (user && user.isPaid) {
      const updated = await incrementTap(data.name);
      const leaderboard = await getLeaderboard();
      const total = await getTotalTaps();
      io.emit('leaderboard_update', leaderboard);
      io.emit('total_taps', { total });
      socket.emit('tap_confirmed', { name: updated.name, tapCount: updated.tapCount });
    } else {
      socket.emit('error', { message: '💳 Payez pour débloquer le jeu !' });
    }
  });

  socket.on('disconnect', () => {
    console.log('👋 Joueur déconnecté');
  });
});

// --- Démarrage ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 MILTAPE PRO démarré sur le port ${PORT}`);
  console.log(`📱 http://localhost:${PORT}`);
  console.log(`💳 Mode: ${User ? 'Payant' : 'Démonstration'}`);
});
