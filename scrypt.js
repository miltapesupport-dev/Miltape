// ============================================================
// MILTAPE - SCRIPT PRINCIPAL
// ============================================================

const socket = io(window.location.origin);
let currentUser = null;
let tapCount = 0;
let selectedBet = 1;
let userData = null;
let timerSeconds = 600;
let timerInterval = null;
let isGameActive = false;
let leaderboardData = [];

// ===================== SOCKET =====================

socket.on('connect', () => {
  console.log('✅ Connecté au serveur');
  socket.emit('get_leaderboard');
  socket.emit('get_total_taps');
});

socket.on('leaderboard_update', (data) => {
  leaderboardData = data || [];
  updateLeaderboard(leaderboardData);
});

socket.on('total_taps', (data) => {
  document.getElementById('playerCount').textContent = (data.total || 0).toLocaleString();
});

socket.on('tap_confirmed', (data) => {
  if (data.name === currentUser) {
    tapCount = data.tapCount;
    document.getElementById('tapCount').textContent = tapCount;
    updatePlayerInfo();
  }
});

socket.on('error', (data) => {
  showToast('❌ ' + (data.message || 'Erreur'));
});

// ===================== UI =====================

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window._t);
  window._t = setTimeout(() => t.style.display = 'none', 2500);
}

function openModal() { document.getElementById('modal').classList.add('show'); }
function closeModal() { document.getElementById('modal').classList.remove('show'); }
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

function shareGame() {
  const text = '🎮 MILTAPE World Challenge !\nTape pour gagner !\n' + window.location.href;
  if (navigator.share) {
    navigator.share({ title: 'MILTAPE', text: text });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('📋 Lien copié !'));
  } else {
    showToast('📋 ' + text);
  }
}

function selectBet(el) {
  document.querySelectorAll('.bet-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  selectedBet = parseInt(el.dataset.bet);
  document.getElementById('betDisplay').textContent = `${selectedBet}€`;
}

// ===================== TIMER =====================

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerSeconds = 600;
  updateTimerDisplay();
  isGameActive = true;
  
  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      isGameActive = false;
      showToast('⏰ Temps écoulé ! Nouvelle partie bientôt !');
      document.getElementById('tapCircle').classList.add('locked');
      setTimeout(startTimer, 5000);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins = Math.floor(timerSeconds / 60);
  const secs = timerSeconds % 60;
  document.getElementById('timer').textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}

// ===================== LEADERBOARD =====================

function updateLeaderboard(data) {
  const container = document.getElementById('leaderboard');
  let html = `<div class="lb-item lb-header"><span>#</span><span>JOUEUR</span><span>TAPS</span></div>`;
  
  (data || []).slice(0, 10).forEach((item, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
    const isMe = item.name === currentUser;
    html += `<div class="lb-item" style="${isMe ? 'color:#ffd42e;' : ''}">
      <span class="rank">${medal}</span>
      <span class="name">${item.name}</span>
      <span class="score">${item.tapCount}</span>
    </div>`;
  });
  if (!data || data.length === 0) {
    html += `<div class="lb-item" style="color:#333;justify-content:center;padding:4px 0;font-size:7px">Aucun joueur</div>`;
  }
  container.innerHTML = html;
}

// ===================== PLAYER INFO =====================

function updatePlayerInfo() {
  if (currentUser) {
    document.getElementById('playerName').textContent = currentUser;
    document.getElementById('tapCount').textContent = tapCount;
    document.getElementById('walletDisplay').textContent = (tapCount * selectedBet / 100).toFixed(2);
    
    const idx = leaderboardData.findIndex(i => i.name === currentUser);
    document.getElementById('playerRank').textContent = idx !== -1 ? `#${idx+1}` : '—';
  }
}

// ===================== CHAT =====================

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !currentUser) { 
    if (!currentUser) showToast('📝 Connecte-toi d\'abord !');
    return; 
  }
  
  const chatDiv = document.getElementById('chatMessages');
  const time = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  chatDiv.innerHTML += `<div class="chat-msg">
    <span class="user">${currentUser}</span>
    <span class="time">${time}</span>
    ${msg}
  </div>`;
  chatDiv.scrollTop = chatDiv.scrollHeight;
  input.value = '';
  if (chatDiv.children.length > 20) {
    chatDiv.removeChild(chatDiv.children[1]);
  }
}

document.getElementById('chatInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendChat();
});

// ===================== TAP =====================

document.getElementById('tapCircle').addEventListener('pointerdown', function(e) {
  e.preventDefault();
  if (!currentUser) { openModal(); return; }
  if (!isGameActive) { showToast('⏰ Attends la prochaine partie !'); return; }

  this.style.transform = 'scale(.93)';
  setTimeout(() => this.style.transform = 'scale(1)', 80);

  const p = document.createElement('div');
  p.className = 'tap-particle';
  p.textContent = '+1';
  const rect = this.getBoundingClientRect();
  p.style.left = (rect.left + rect.width/2 - 12 + (Math.random()-0.5)*30) + 'px';
  p.style.top = (rect.top + rect.height/2 - 12) + 'px';
  p.style.animation = 'particleUp 0.5s ease-out forwards';
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 600);

  if (navigator.vibrate) navigator.vibrate(5);
  
  socket.emit('user_tap', { name: currentUser });
  tapCount++;
  document.getElementById('tapCount').textContent = tapCount;
  document.getElementById('walletDisplay').textContent = (tapCount * selectedBet / 100).toFixed(2);
});

// ===================== INSCRIPTION =====================

async function registerUser() {
  const name = document.getElementById('nameInput').value.trim();
  const wallet = document.getElementById('walletInput').value.trim();
  
  if (!name) { showToast('📝 Entre ton pseudo !'); return; }
  if (name.length < 2) { showToast('📝 Pseudo trop court'); return; }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, wallet: wallet || undefined })
    });
    const data = await res.json();
    
    if (res.ok) {
      currentUser = name;
      tapCount = data.user?.tapCount || 0;
      userData = data.user;
      document.getElementById('tapCount').textContent = tapCount;
      document.getElementById('playerName').textContent = name;
      document.getElementById('tapCircle').classList.remove('locked');
      document.getElementById('tapCircle').querySelector('.lock-icon').style.display = 'none';
      updatePlayerInfo();
      closeModal();
      showToast(`✅ Bienvenue ${name} !`);
      socket.emit('get_leaderboard');
      socket.emit('get_total_taps');
      
      if (!timerInterval) startTimer();
      
      try { localStorage.setItem('miltape_user', JSON.stringify({ name, wallet })); } catch(e) {}
    } else {
      showToast('❌ ' + (data.error || 'Erreur'));
    }
  } catch (error) {
    showToast('❌ Erreur de connexion');
  }
}

// ===================== RESTORE SESSION =====================

try {
  const saved = localStorage.getItem('miltape_user');
  if (saved) {
    const data = JSON.parse(saved);
    if (data.name) {
      currentUser = data.name;
      document.getElementById('playerName').textContent = data.name;
      document.getElementById('nameInput').value = data.name;
      document.getElementById('walletInput').value = data.wallet || '';
      document.getElementById('tapCircle').classList.remove('locked');
      document.getElementById('tapCircle').querySelector('.lock-icon').style.display = 'none';
      updatePlayerInfo();
      
      if (!timerInterval) startTimer();
      
      setTimeout(() => {
        socket.emit('get_leaderboard');
        socket.emit('get_total_taps');
      }, 500);
    }
  }
} catch(e) {}

// ===================== MODAL CLICK OUTSIDE =====================

document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

console.log('🎮 MILTAPE World Challenge');
