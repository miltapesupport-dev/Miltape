'use strict';

/*
 * MILTAPE — World Challenge
 * Backend réel : chrono serveur + parties + mises + TAP + Top 5 + Socket.IO + MongoDB
 *
 * Variables Railway / .env :
 * PORT=3000
 * MONGODB_URI=mongodb+srv://...
 * FRONTEND_URL=https://ton-domaine.com
 * TRON_FULL_HOST=https://api.trongrid.io
 * TRON_USDT_CONTRACT=TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj
 * TRON_TREASURY_ADDRESS=T...
 * TRONGRID_API_KEY=...
 * GAME_DURATION_SECONDS=600
 * MINIMUM_BET=1
 * MAXIMUM_BET=1000
 *
 * IMPORTANT : aucune clé privée n'est nécessaire pour recevoir
 * et vérifier les mises. Ne mets jamais une clé privée dans le frontend.
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const GAME_DURATION_SECONDS =
  Number(process.env.GAME_DURATION_SECONDS || 600);

const MINIMUM_BET =
  Number(process.env.MINIMUM_BET || 1);

const MAXIMUM_BET =
  Number(process.env.MAXIMUM_BET || 1000);

const TRON_FULL_HOST =
  process.env.TRON_FULL_HOST || 'https://api.trongrid.io';

const TRON_USDT_CONTRACT =
  process.env.TRON_USDT_CONTRACT ||
  'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

const TRON_TREASURY_ADDRESS =
  process.env.TRON_TREASURY_ADDRESS || '';

const TRONGRID_API_KEY =
  process.env.TRONGRID_API_KEY || '';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI est manquant.');
  process.exit(1);
}

app.set('trust proxy', 1);

app.use(cors({
  origin:
    FRONTEND_URL === '*'
      ? true
      : FRONTEND_URL.split(',').map(s => s.trim()),
  credentials: true
}));

app.use(express.json({
  limit: '100kb'
}));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'miltape-backend',
    time: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// MongoDB MODELS
// -----------------------------------------------------------------------------

const gameSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['WAITING', 'RUNNING', 'FINISHED'],
    default: 'WAITING',
    index: true
  },

  durationSeconds: {
    type: Number,
    required: true,
    default: GAME_DURATION_SECONDS
  },

  startedAt: {
    type: Date,
    default: null
  },

  endsAt: {
    type: Date,
    default: null
  },

  finishedAt: {
    type: Date,
    default: null
  },

  totalStakes: {
    type: Number,
    default: 0
  },

  playerCount: {
    type: Number,
    default: 0
  },

  winnerIds: {
    type: [String],
    default: []
  }

}, {
  timestamps: true
});

gameSchema.index({
  status: 1,
  createdAt: -1
});

const playerSchema = new mongoose.Schema({
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true,
    index: true
  },

  playerId: {
    type: String,
    required: true,
    index: true
  },

  name: {
    type: String,
    required: true,
    maxlength: 32
  },

  wallet: {
    type: String,
    default: ''
  },

  paymentMethod: {
    type: String,
    enum: ['tron', 'telegram'],
    default: 'tron'
  },

  paymentTxId: {
    type: String,
    default: '',
    index: true
  },

  stake: {
    type: Number,
    required: true,
    min: MINIMUM_BET,
    max: MAXIMUM_BET
  },

  taps: {
    type: Number,
    default: 0,
    min: 0
  },

  joinedAt: {
    type: Date,
    default: Date.now
  },

  finishedRank: {
    type: Number,
    default: null
  },

  payout: {
    type: Number,
    default: 0
  }

}, {
  timestamps: true
});

playerSchema.index({
  gameId: 1,
  playerId: 1
}, {
  unique: true
});

playerSchema.index({
  gameId: 1,
  taps: -1,
  joinedAt: 1
});

const paymentSchema = new mongoose.Schema({
  txId: {
    type: String,
    unique: true,
    index: true
  },

  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },

  playerId: {
    type: String,
    required: true
  },

  from: {
    type: String,
    required: true
  },

  to: {
    type: String,
    required: true
  },

  amount: {
    type: Number,
    required: true
  },

  token: {
    type: String,
    required: true
  },

  status: {
    type: String,
    enum: ['VERIFIED', 'USED'],
    default: 'VERIFIED'
  },

  verifiedAt: {
    type: Date,
    default: Date.now
  }

}, {
  timestamps: true
});

const messageSchema = new mongoose.Schema({
  playerId: {
    type: String,
    default: 'system'
  },

  name: {
    type: String,
    default: 'Système',
    maxlength: 32
  },

  text: {
    type: String,
    required: true,
    maxlength: 300
  }

}, {
  timestamps: true
});

const Game = mongoose.model('Game', gameSchema);
const Player = mongoose.model('Player', playerSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Message = mongoose.model('Message', messageSchema);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cleanName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 32);
}

function cleanWallet(value) {
  return String(value || '').trim();
}

function cleanTxId(value) {
  return String(value || '').trim();
}

function makePlayerId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000000) / 1000000;
}
// -----------------------------------------------------------------------------
// GAME HELPERS
// -----------------------------------------------------------------------------

async function getCurrentGame() {
  let game = await Game.findOne({
    status: { $in: ['WAITING', 'RUNNING'] }
  }).sort({ createdAt: -1 });

  if (!game) {
    game = await Game.create({
      status: 'WAITING',
      durationSeconds: GAME_DURATION_SECONDS
    });
  }

  return game;
}

async function startGameIfNeeded(game) {
  if (game.status === 'RUNNING') {
    return game;
  }

  if (game.status !== 'WAITING') {
    return game;
  }

  const now = new Date();

  game.status = 'RUNNING';
  game.startedAt = now;
  game.endsAt = new Date(
    now.getTime() + game.durationSeconds * 1000
  );

  await game.save();

  io.to(`game:${game._id}`).emit('game:started', {
    gameId: String(game._id),
    startedAt: game.startedAt,
    endsAt: game.endsAt,
    durationSeconds: game.durationSeconds
  });

  return game;
}

function remainingSeconds(game) {
  if (!game || game.status !== 'RUNNING' || !game.endsAt) {
    return 0;
  }

  const diff =
    new Date(game.endsAt).getTime() - Date.now();

  return Math.max(
    0,
    Math.ceil(diff / 1000)
  );
}

async function getLeaderboard(gameId) {
  return Player.find({
    gameId
  })
    .sort({
      taps: -1,
      joinedAt: 1
    })
    .lean();
}

function formatLeaderboard(players) {
  return players.map((player, index) => ({
    rank: index + 1,
    playerId: player.playerId,
    name: player.name,
    wallet: player.wallet,
    stake: player.stake,
    taps: player.taps,
    payout: player.payout || 0
  }));
}

async function broadcastLeaderboard(gameId) {
  const players = await getLeaderboard(gameId);

  io.to(`game:${gameId}`).emit(
    'leaderboard:update',
    {
      gameId: String(gameId),
      leaderboard: formatLeaderboard(players)
    }
  );
}

async function finishGame(game) {
  if (!game) return null;

  if (game.status === 'FINISHED') {
    return game;
  }

  const players = await getLeaderboard(game._id);

  const topFive = players.slice(0, 5);

  for (let i = 0; i < players.length; i++) {
    await Player.updateOne(
      { _id: players[i]._id },
      {
        $set: {
          finishedRank: i + 1,
          payout:
            i < 5
              ? roundMoney(players[i].stake * 2)
              : 0
        }
      }
    );
  }

  game.status = 'FINISHED';
  game.finishedAt = new Date();
  game.winnerIds = topFive.map(
    player => player.playerId
  );

  await game.save();

  const finalPlayers = await getLeaderboard(game._id);

  io.to(`game:${game._id}`).emit(
    'game:finished',
    {
      gameId: String(game._id),
      winnerIds: game.winnerIds,
      leaderboard: formatLeaderboard(finalPlayers)
    }
  );

  io.to(`game:${game._id}`).emit(
    'timer:tick',
    {
      gameId: String(game._id),
      remainingSeconds: 0
    }
  );

  return game;
}

async function ensureGameNotExpired(game) {
  if (
    game &&
    game.status === 'RUNNING' &&
    remainingSeconds(game) <= 0
  ) {
    return finishGame(game);
  }

  return game;
}

// -----------------------------------------------------------------------------
// TRON HELPERS
// -----------------------------------------------------------------------------

function isValidTronAddress(address) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(
    String(address || '').trim()
  );
}

function isValidTxId(txId) {
  return /^[a-fA-F0-9]{64}$/.test(
    String(txId || '').trim()
  );
}

function amountMatchesStake(rawValue, stake) {
  const expected =
    BigInt(Math.round(Number(stake) * 1000000));

  try {
    return BigInt(String(rawValue)) === expected;
  } catch {
    return false;
  }
}

async function verifyTronUsdtTransfer({
  txId,
  fromAddress,
  stake
}) {
  if (!TRON_TREASURY_ADDRESS) {
    return {
      ok: false,
      code: 'TRON_TREASURY_NOT_CONFIGURED'
    };
  }

  if (!TRONGRID_API_KEY) {
    console.warn(
      '⚠️ TRONGRID_API_KEY non configurée.'
    );
  }

  const url =
    `${TRON_FULL_HOST}/v1/transactions/` +
    `${encodeURIComponent(txId)}/events` +
    `?only_confirmed=true&limit=200`;

  const headers = {
    Accept: 'application/json'
  };

  if (TRONGRID_API_KEY) {
    headers['TRON-PRO-API-KEY'] =
      TRONGRID_API_KEY;
  }

  let response;

  try {
    response = await fetch(url, {
      method: 'GET',
      headers
    });
  } catch (error) {
    console.error(
      'Erreur connexion TronGrid:',
      error
    );

    return {
      ok: false,
      code: 'TRONGRID_CONNECTION_ERROR'
    };
  }

  if (!response.ok) {
    const text = await response.text();

    console.error(
      'TronGrid HTTP',
      response.status,
      text
    );

    return {
      ok: false,
      code: 'TRONGRID_HTTP_ERROR',
      status: response.status
    };
  }

  let data;

  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      code: 'TRONGRID_INVALID_RESPONSE'
    };
  }

  const events =
    Array.isArray(data?.data)
      ? data.data
      : [];

  for (const event of events) {
    if (event.event_name !== 'Transfer') {
      continue;
    }

    const result = event.result || {};

    const from =
      result.from ||
      result._from ||
      '';

    const to =
      result.to ||
      result._to ||
      '';

    const value =
      result.value ||
      result._value ||
      '0';

    const contract =
      event.address ||
      event.contract_address ||
      '';

    if (
      from === fromAddress &&
      to === TRON_TREASURY_ADDRESS &&
      contract === TRON_USDT_CONTRACT &&
      amountMatchesStake(value, stake)
    ) {
      return {
        ok: true,
        from,
        to,
        amount: Number(stake),
        token: 'USDT-TRC20',
        contract
      };
    }
  }

  return {
    ok: false,
    code: 'PAYMENT_NOT_FOUND'
  };
}
// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

app.get('/api/game', async (_req, res) => {
  try {
    let game = await getCurrentGame();
    game = await ensureGameNotExpired(game);

    const players = await getLeaderboard(game._id);

    res.json({
      ok: true,
      game: {
        id: String(game._id),
        status: game.status,
        durationSeconds: game.durationSeconds,
        startedAt: game.startedAt,
        endsAt: game.endsAt,
        remainingSeconds: remainingSeconds(game),
        totalStakes: game.totalStakes,
        playerCount: players.length
      },
      leaderboard: formatLeaderboard(players)
    });
  } catch (error) {
    console.error('GET /api/game:', error);

    res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR'
    });
  }
});

// -----------------------------------------------------------------------------
// JOIN
// -----------------------------------------------------------------------------

app.post('/api/join', async (req, res) => {
  try {
    const {
      playerId,
      name,
      wallet,
      stake,
      paymentMethod,
      paymentTxId
    } = req.body || {};

    const cleanPlayerId =
      String(playerId || '').trim() ||
      makePlayerId();

    const cleanPlayerName = cleanName(name);
    const cleanPlayerWallet = cleanWallet(wallet);
    const cleanPaymentMethod =
      String(paymentMethod || 'tron').toLowerCase();

    const numericStake = Number(stake);

    if (!cleanPlayerName) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_NAME',
        message: 'Nom du joueur obligatoire.'
      });
    }

    if (
      !Number.isFinite(numericStake) ||
      numericStake < MINIMUM_BET ||
      numericStake > MAXIMUM_BET
    ) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_STAKE',
        message:
          `La mise doit être comprise entre ${MINIMUM_BET} et ${MAXIMUM_BET} USDT.`
      });
    }

    let game = await getCurrentGame();
    game = await ensureGameNotExpired(game);

    // Si une partie est terminée entre-temps,
    // on crée/récupère une nouvelle partie.
    if (game.status === 'FINISHED') {
      game = await getCurrentGame();
    }

    // Vérification avant paiement pour éviter
    // qu'un joueur déjà inscrit utilise inutilement
    // un TXID.
    const alreadyJoined = await Player.findOne({
      gameId: game._id,
      playerId: cleanPlayerId
    }).lean();

    if (alreadyJoined) {
      return res.status(409).json({
        ok: false,
        code: 'ALREADY_JOINED',
        message: 'Ce joueur est déjà inscrit à cette partie.'
      });
    }

    // -------------------------------------------------------------------------
    // PAIEMENT TRON
    // -------------------------------------------------------------------------

    if (cleanPaymentMethod === 'tron') {
      if (!isValidTronAddress(cleanPlayerWallet)) {
        return res.status(400).json({
          ok: false,
          code: 'INVALID_TRON_ADDRESS',
          message: 'Adresse TRON invalide.'
        });
      }

      const cleanPaymentTxId =
        cleanTxId(paymentTxId);

      if (!isValidTxId(cleanPaymentTxId)) {
        return res.status(400).json({
          ok: false,
          code: 'INVALID_TXID',
          message: 'TXID TRON invalide.'
        });
      }

      // Le même TXID ne peut pas être utilisé deux fois.
      const existingPayment =
        await Payment.findOne({
          txId: cleanPaymentTxId
        }).lean();

      if (existingPayment) {
        return res.status(409).json({
          ok: false,
          code: 'PAYMENT_ALREADY_USED',
          message: 'Cette transaction a déjà été utilisée.'
        });
      }

      const verification =
        await verifyTronUsdtTransfer({
          txId: cleanPaymentTxId,
          fromAddress: cleanPlayerWallet,
          stake: numericStake
        });

      if (!verification.ok) {
        return res.status(400).json({
          ok: false,
          code: verification.code,
          message:
            'Le paiement USDT TRC20 n’a pas pu être vérifié.'
        });
      }

      // Enregistre le paiement comme vérifié.
      try {
        await Payment.create({
          txId: cleanPaymentTxId,
          gameId: game._id,
          playerId: cleanPlayerId,
          from: verification.from,
          to: verification.to,
          amount: verification.amount,
          token: verification.token,
          status: 'USED',
          verifiedAt: new Date()
        });
      } catch (paymentError) {
        if (paymentError.code === 11000) {
          return res.status(409).json({
            ok: false,
            code: 'PAYMENT_ALREADY_USED',
            message: 'Cette transaction a déjà été utilisée.'
          });
        }

        throw paymentError;
      }

      // Re-vérification de l'état de la partie après le paiement.
      game = await Game.findById(game._id);

      if (!game) {
        return res.status(500).json({
          ok: false,
          code: 'GAME_NOT_FOUND'
        });
      }

      game = await ensureGameNotExpired(game);

      if (game.status === 'FINISHED') {
        return res.status(409).json({
          ok: false,
          code: 'GAME_FINISHED',
          message:
            'La partie vient de se terminer. Paiement reçu mais inscription non effectuée.'
        });
      }

      const player = await Player.create({
        gameId: game._id,
        playerId: cleanPlayerId,
        name: cleanPlayerName,
        wallet: cleanPlayerWallet,
        paymentMethod: 'tron',
        paymentTxId: cleanPaymentTxId,
        stake: numericStake,
        taps: 0,
        joinedAt: new Date()
      });

      game.totalStakes =
        roundMoney(
          Number(game.totalStakes || 0) +
          numericStake
        );

      game.playerCount =
        await Player.countDocuments({
          gameId: game._id
        });

      await game.save();

      // La première inscription démarre la partie.
      game = await startGameIfNeeded(game);

      io.to(`game:${game._id}`).emit(
        'player:joined',
        {
          gameId: String(game._id),
          playerId: player.playerId,
          name: player.name
        }
      );

      await broadcastLeaderboard(game._id);

      return res.json({
        ok: true,
        player: {
          playerId: player.playerId,
          name: player.name,
          wallet: player.wallet,
          stake: player.stake,
          taps: player.taps
        },
        game: {
          id: String(game._id),
          status: game.status,
          startedAt: game.startedAt,
          endsAt: game.endsAt,
          remainingSeconds:
            remainingSeconds(game)
        }
      });
    }

    // -------------------------------------------------------------------------
    // TELEGRAM
    // -------------------------------------------------------------------------

    if (cleanPaymentMethod === 'telegram') {
      return res.status(501).json({
        ok: false,
        code: 'TELEGRAM_PAYMENT_NOT_CONNECTED',
        message:
          'Le paiement Telegram n’est pas encore connecté au backend.'
      });
    }

    return res.status(400).json({
      ok: false,
      code: 'INVALID_PAYMENT_METHOD',
      message: 'Méthode de paiement inconnue.'
    });

  } catch (error) {
    console.error('POST /api/join:', error);

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Erreur serveur.'
    });
  }
});

// -----------------------------------------------------------------------------
// TAP
// -----------------------------------------------------------------------------

app.post('/api/tap', async (req, res) => {
  try {
    const {
      gameId,
      playerId
    } = req.body || {};

    if (!gameId || !playerId) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_DATA'
      });
    }

    let game = await Game.findById(gameId);

    if (!game) {
      return res.status(404).json({
        ok: false,
        code: 'GAME_NOT_FOUND'
      });
    }

    game = await ensureGameNotExpired(game);

    if (game.status !== 'RUNNING') {
      return res.status(400).json({
        ok: false,
        code: 'GAME_NOT_RUNNING',
        message: 'La partie n’est pas en cours.'
      });
    }

    if (remainingSeconds(game) <= 0) {
      await finishGame(game);

      return res.status(400).json({
        ok: false,
        code: 'GAME_FINISHED'
      });
    }

    const player = await Player.findOneAndUpdate(
      {
        gameId: game._id,
        playerId: String(playerId)
      },
      {
        $inc: {
          taps: 1
        }
      },
      {
        new: true
      }
    );

    if (!player) {
      return res.status(404).json({
        ok: false,
        code: 'PLAYER_NOT_FOUND',
        message: 'Joueur non inscrit.'
      });
    }

    const players =
      await getLeaderboard(game._id);

    const index =
      players.findIndex(
        p => p.playerId === player.playerId
      );

    const rank =
      index === -1
        ? null
        : index + 1;

    const payload = {
      gameId: String(game._id),
      playerId: player.playerId,
      taps: player.taps,
      rank,
      remainingSeconds:
        remainingSeconds(game)
    };

    io.to(`game:${game._id}`).emit(
      'tap:update',
      payload
    );

    io.to(`game:${game._id}`).emit(
      'leaderboard:update',
      {
        gameId: String(game._id),
        leaderboard:
          formatLeaderboard(players)
      }
    );

    return res.json({
      ok: true,
      ...payload
    });

  } catch (error) {
    console.error('POST /api/tap:', error);

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR'
    });
  }
});
// -----------------------------------------------------------------------------
// LEADERBOARD
// -----------------------------------------------------------------------------

app.get('/api/leaderboard', async (req, res) => {
  try {
    const gameId = String(req.query.gameId || '').trim();

    if (!gameId) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_GAME_ID'
      });
    }

    const game = await Game.findById(gameId);

    if (!game) {
      return res.status(404).json({
        ok: false,
        code: 'GAME_NOT_FOUND'
      });
    }

    await ensureGameNotExpired(game);

    const players =
      await getLeaderboard(game._id);

    res.json({
      ok: true,
      gameId: String(game._id),
      leaderboard:
        formatLeaderboard(players)
    });

  } catch (error) {
    console.error(
      'GET /api/leaderboard:',
      error
    );

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR'
    });
  }
});

// -----------------------------------------------------------------------------
// PLAYER
// -----------------------------------------------------------------------------

app.get('/api/player/:playerId', async (req, res) => {
  try {
    const playerId =
      String(req.params.playerId || '').trim();

    const player =
      await Player.findOne({
        playerId
      }).sort({
        createdAt: -1
      }).lean();

    if (!player) {
      return res.status(404).json({
        ok: false,
        code: 'PLAYER_NOT_FOUND'
      });
    }

    const players =
      await getLeaderboard(player.gameId);

    const index =
      players.findIndex(
        p => p.playerId === player.playerId
      );

    res.json({
      ok: true,
      player: {
        playerId: player.playerId,
        name: player.name,
        wallet: player.wallet,
        stake: player.stake,
        taps: player.taps,
        rank:
          index === -1
            ? null
            : index + 1,
        payout: player.payout || 0,
        finishedRank:
          player.finishedRank
      }
    });

  } catch (error) {
    console.error(
      'GET /api/player:',
      error
    );

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR'
    });
  }
});

// -----------------------------------------------------------------------------
// CHAT
// -----------------------------------------------------------------------------

app.get('/api/chat', async (_req, res) => {
  try {
    const messages =
      await Message.find({})
        .sort({
          createdAt: -1
        })
        .limit(100)
        .lean();

    res.json({
      ok: true,
      messages:
        messages.reverse().map(message => ({
          id: String(message._id),
          playerId: message.playerId,
          name: message.name,
          text: message.text,
          createdAt: message.createdAt
        }))
    });

  } catch (error) {
    console.error(
      'GET /api/chat:',
      error
    );

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR'
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      playerId,
      name,
      text
    } = req.body || {};

    const cleanText =
      String(text || '')
        .trim()
        .slice(0, 300);

    if (!cleanText) {
      return res.status(400).json({
        ok: false,
        code: 'EMPTY_MESSAGE'
      });
    }

    const message =
      await Message.create({
        playerId:
          String(playerId || 'anonymous'),
        name:
          cleanName(name) || 'Joueur',
        text: cleanText
      });

    const payload = {
      id: String(message._id),
      playerId: message.playerId,
      name: message.name,
      text: message.text,
      createdAt: message.createdAt
    };

    io.emit(
      'chat:message',
      payload
    );

    res.json({
      ok: true,
      message: payload
    });

  } catch (error) {
    console.error(
      'POST /api/chat:',
      error
    );

    res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR'
    });
  }
});

// -----------------------------------------------------------------------------
// SOCKET.IO
// -----------------------------------------------------------------------------

const io = new Server(server, {
  cors: {
    origin:
      FRONTEND_URL === '*'
        ? true
        : FRONTEND_URL
            .split(',')
            .map(s => s.trim()),
    methods: ['GET', 'POST'],
    credentials: true
  }
});

function getOnlineCount() {
  return io.engine.clientsCount;
}

io.on('connection', async socket => {
  console.log(
    '🔌 Socket connecté:',
    socket.id
  );

  socket.emit(
    'server:ready',
    {
      ok: true,
      socketId: socket.id
    }
  );

  io.emit(
    'online:count',
    getOnlineCount()
  );

  socket.on(
    'game:join',
    async payload => {
      try {
        const gameId =
          String(
            payload?.gameId || ''
          ).trim();

        if (!gameId) {
          return;
        }

        const game =
          await Game.findById(gameId);

        if (!game) {
          return;
        }

        await ensureGameNotExpired(game);

        socket.join(
          `game:${gameId}`
        );

        const players =
          await getLeaderboard(game._id);

        socket.emit(
          'game:state',
          {
            gameId,
            status: game.status,
            startedAt: game.startedAt,
            endsAt: game.endsAt,
            remainingSeconds:
              remainingSeconds(game),
            totalStakes:
              game.totalStakes,
            playerCount:
              players.length,
            leaderboard:
              formatLeaderboard(players)
          }
        );

      } catch (error) {
        console.error(
          'socket game:join:',
          error
        );
      }
    }
  );

  socket.on(
    'chat:send',
    async payload => {
      try {
        const cleanText =
          String(
            payload?.text || ''
          )
            .trim()
            .slice(0, 300);

        if (!cleanText) {
          return;
        }

        const message =
          await Message.create({
            playerId:
              String(
                payload?.playerId ||
                'anonymous'
              ),
            name:
              cleanName(
                payload?.name
              ) || 'Joueur',
            text: cleanText
          });

        io.emit(
          'chat:message',
          {
            id: String(message._id),
            playerId:
              message.playerId,
            name:
              message.name,
            text:
              message.text,
            createdAt:
              message.createdAt
          }
        );

      } catch (error) {
        console.error(
          'socket chat:send:',
          error
        );
      }
    }
  );

  socket.on(
    'disconnect',
    reason => {
      console.log(
        '🔌 Socket déconnecté:',
        socket.id,
        reason
      );

      io.emit(
        'online:count',
        getOnlineCount()
      );
    }
  );
});

// -----------------------------------------------------------------------------
// SERVER GAME LOOP
// -----------------------------------------------------------------------------

let gameLoopRunning = false;

async function gameLoop() {
  if (gameLoopRunning) {
    return;
  }

  gameLoopRunning = true;

  try {
    const games =
      await Game.find({
        status: 'RUNNING'
      });

    for (const game of games) {
      if (remainingSeconds(game) <= 0) {
        await finishGame(game);
        continue;
      }

      io.to(
        `game:${game._id}`
      ).emit(
        'timer:tick',
        {
          gameId:
            String(game._id),
          remainingSeconds:
            remainingSeconds(game)
        }
      );
    }

  } catch (error) {
    console.error(
      'GAME LOOP:',
      error
    );
  } finally {
    gameLoopRunning = false;
  }
}

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

async function startServer() {
  try {
    console.log(
      '⏳ Connexion à MongoDB...'
    );

    await mongoose.connect(
      MONGODB_URI,
      {
        serverSelectionTimeoutMS: 10000
      }
    );

    console.log(
      '✅ MongoDB connecté'
    );

    server.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log(
          `🚀 Miltape backend démarré sur le port ${PORT}`
        );

        console.log(
          `⏱️ Durée partie: ${GAME_DURATION_SECONDS}s`
        );

        console.log(
          `💰 Mise minimum: ${MINIMUM_BET} USDT`
        );

        console.log(
          `💰 Mise maximum: ${MAXIMUM_BET} USDT`
        );
      }
    );

    setInterval(
      gameLoop,
      1000
    );

  } catch (error) {
    console.error(
      '❌ Impossible de démarrer le serveur:',
      error
    );

    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// SHUTDOWN PROPRE
// -----------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(
    `🛑 Signal ${signal} reçu. Arrêt du serveur...`
  );

  try {
    await mongoose.connection.close();

    server.close(() => {
      process.exit(0);
    });

  } catch (error) {
    console.error(
      'Erreur arrêt:',
      error
    );

    process.exit(1);
  }
}

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

startServer();
