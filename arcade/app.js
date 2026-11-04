// じゅうでんアーケード: voice game (microphone) + face game (cabin camera)

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const video = $('video');
const overlay = $('overlay');

let W = 0, H = 0;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- UI helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'game') resize();
}

function showOverlay(html, buttons = []) {
  overlay.innerHTML = html;
  if (buttons.length) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      row.appendChild(el);
    }
    overlay.appendChild(row);
  }
  overlay.classList.add('show');
}
function hideOverlay() { overlay.classList.remove('show'); }

let noticeTimer = null;
function notice(text, ms = 4000) {
  const el = $('notice');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => (el.style.display = 'none'), ms);
}
function hideNotice() { $('notice').style.display = 'none'; }

function errName(err) {
  return err && err.name ? err.name : String(err);
}

// ---------- Media ----------
let micStream = null, audioCtx = null, analyser = null, waveBuf = null;

async function ensureMic() {
  if (micStream && micStream.getAudioTracks()[0].readyState === 'live') return true;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  waveBuf = new Float32Array(analyser.fftSize);
  src.connect(analyser);
  return true;
}

function micDb() {
  if (!analyser) return -100;
  analyser.getFloatTimeDomainData(waveBuf);
  let sum = 0;
  for (let i = 0; i < waveBuf.length; i++) sum += waveBuf[i] * waveBuf[i];
  const rms = Math.sqrt(sum / waveBuf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

let camStream = null;
let onCamLost = null;

function camLive() {
  return !!(camStream && camStream.getVideoTracks()[0].readyState === 'live');
}

async function ensureCam() {
  if (camLive()) return true;
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 } }
  });
  // The camera is cut when the car leaves Park; fall back to touch instead of freezing
  camStream.getVideoTracks()[0].addEventListener('ended', () => {
    camStream = null;
    video.srcObject = null;
    if (onCamLost) onCamLost();
  });
  video.srcObject = camStream;
  await new Promise((res) => {
    if (video.readyState >= 2) return res();
    video.addEventListener('loadeddata', res, { once: true });
  });
  return true;
}

function stopCam() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  video.srcObject = null;
}

// Mirrored snapshot with the score stamped on it, small enough for localStorage
function snapshot(title, score) {
  if (!camLive() || !video.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  const vr = video.videoWidth / video.videoHeight, cr = c.width / c.height;
  let sw = video.videoWidth, sh = video.videoHeight, sx = 0, sy = 0;
  if (vr > cr) { sw = sh * cr; sx = (video.videoWidth - sw) / 2; } else { sh = sw / cr; sy = (video.videoHeight - sh) / 2; }
  g.translate(c.width, 0);
  g.scale(-1, 1);
  g.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 190, 320, 50);
  g.fillStyle = '#fff';
  g.font = 'bold 18px sans-serif';
  g.fillText(title, 10, 212);
  g.font = 'bold 22px sans-serif';
  g.textAlign = 'right';
  g.fillText(score + ' 点', 310, 232);
  g.textAlign = 'left';
  g.font = '12px sans-serif';
  g.fillText(new Date().toLocaleDateString('ja-JP'), 10, 232);
  return c.toDataURL('image/jpeg', 0.7);
}

// ---------- Hall of fame ----------
const FAME_KEY = 'arcadeFame';
function loadFame() {
  try { return JSON.parse(localStorage.getItem(FAME_KEY)) || []; } catch (e) { return []; }
}
function saveFame(list) {
  try { localStorage.setItem(FAME_KEY, JSON.stringify(list)); } catch (e) {}
}
// Keeps the top 5 per game; returns the rank (1-based, 0 if it didn't place) and the entry's key
function addFame(game, score, img) {
  if (score <= 0) return { rank: 0, at: 0 };
  const list = loadFame();
  const entry = { game, score, img, at: Date.now() };
  list.push(entry);
  const mine = list.filter((e) => e.game === game).sort((a, b) => b.score - a.score);
  const keep = new Set(mine.slice(0, 5));
  const next = list.filter((e) => e.game !== game || keep.has(e));
  saveFame(next);
  return { rank: keep.has(entry) ? mine.indexOf(entry) + 1 : 0, at: entry.at };
}
function bestScore(game) {
  return loadFame().filter((e) => e.game === game).reduce((m, e) => Math.max(m, e.score), 0);
}
function attachPhoto(at, img) {
  const list = loadFame();
  const e = list.find((x) => x.at === at);
  if (e) { e.img = img; saveFame(list); }
}

function renderFame() {
  const box = $('fame-list');
  const list = loadFame().sort((a, b) => b.at - a.at);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="fame-empty">まだ記録がありません。遊ぶとここに記念写真とスコアが残ります。</div>';
    return;
  }
  const order = [...list].sort((a, b) => b.score - a.score);
  for (const e of order) {
    const item = document.createElement('div');
    item.className = 'fame-item';
    const icon = e.game === 'voice' ? '🐤' : '😮';
    if (e.img) {
      const img = document.createElement('img');
      img.src = e.img;
      item.appendChild(img);
    } else {
      const d = document.createElement('div');
      d.className = 'noimg';
      d.textContent = icon;
      item.appendChild(d);
    }
    const b = document.createElement('b');
    b.textContent = icon + ' ' + e.score;
    item.appendChild(b);
    const s = document.createElement('span');
    s.textContent = new Date(e.at).toLocaleDateString('ja-JP');
    item.appendChild(s);
    box.appendChild(item);
  }
}

// ---------- Game loop ----------
let current = null;
let rafId = 0;
let lastT = 0;

function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  if (current) {
    if (!current.paused) current.update(dt, t);
    ctx.clearRect(0, 0, W, H);
    current.draw(t);
  }
  rafId = requestAnimationFrame(loop);
}

function startGame(game) {
  showScreen('game');
  hideNotice();
  $('hud-left').textContent = '';
  $('hud-right').textContent = '';
  video.style.display = 'none';
  current = game;
  cancelAnimationFrame(rafId);
  lastT = performance.now();
  rafId = requestAnimationFrame(loop);
  game.start();
}

function quitToMenu() {
  if (current && current.stop) current.stop();
  current = null;
  cancelAnimationFrame(rafId);
  stopCam();
  hideOverlay();
  hideNotice();
  renderFame();
  showScreen('menu');
}
$('quit').addEventListener('click', quitToMenu);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && current && !current.over) current.paused = true;
  else if (!document.hidden && current && current.paused && !current.waiting) current.paused = false;
});

// Result screen shared by both games
function showResult(game, title, score, photo) {
  const { rank, at } = addFame(game.key, score, photo);
  const rankText = rank ? `殿堂入り！ ${rank}位` : `ベスト ${bestScore(game.key)} 点`;
  renderResult(game, title, score, photo, rankText, rank ? at : 0);
}

function renderResult(game, title, score, photo, rankText, photoSlot) {
  const img = photo ? `<img src="${photo}" alt="">` : '';
  const buttons = [
    { label: 'もう一回', cls: game.key, onClick: () => { hideOverlay(); startGame(game.again()); } },
    { label: 'メニュー', cls: 'ghost', onClick: quitToMenu }
  ];
  // No photo yet (voice game, or camera off): offer a commemorative shot if the camera works now
  if (!photo && photoSlot) {
    buttons.unshift({ label: '📸 記念撮影', cls: 'face', onClick: () => takeCommemorative(game, title, score, rankText, photoSlot) });
  }
  showOverlay(`<h2>${title}</h2>${img}<p style="font-size:44px;font-weight:800;">${score} 点</p><p>${rankText}</p>`, buttons);
}

async function takeCommemorative(game, title, score, rankText, photoSlot) {
  try {
    await ensureCam();
  } catch (err) {
    notice('カメラが使えません（停車中のみ使えます）: ' + errName(err));
    return;
  }
  video.style.display = 'block';
  video.style.opacity = '1';
  for (const n of [3, 2, 1]) {
    showOverlay(`<h2>${n}</h2><p>カメラを見てね</p>`);
    overlay.style.background = 'transparent';
    await new Promise((r) => setTimeout(r, 800));
  }
  overlay.style.background = '';
  const shot = snapshot(title, score);
  if (shot) attachPhoto(photoSlot, shot);
  stopCam();
  video.style.display = 'none';
  video.style.opacity = '';
  renderResult(game, title, score, shot, rankText, 0);
}

// Shared pointer state for touch fallbacks
const pointer = { down: false, x: 0, y: 0, seen: false };
canvas.addEventListener('pointerdown', (e) => { pointer.down = true; pointer.seen = true; pointer.x = e.offsetX; pointer.y = e.offsetY; });
canvas.addEventListener('pointermove', (e) => { pointer.x = e.offsetX; pointer.y = e.offsetY; pointer.seen = true; });
window.addEventListener('pointerup', () => { pointer.down = false; });
window.addEventListener('pointercancel', () => { pointer.down = false; });

// ---------- Game 1: こえでとべ！ (microphone) ----------
// Voice volume sets the chick's height directly (silence = ground, loudest = sky),
// so passing a gate means holding your voice at the right level, not timing bursts.
function VoiceGame() {
  const LIVES = 3;
  const g = {
    key: 'voice',
    again: () => VoiceGame(),
    paused: true,
    waiting: true,
    over: false,
    useMic: false,
    low: -45, high: -20,
    level: 0,
    y: 0, prevY: 0,
    dist: 0, stars: 0, gates: 0,
    lives: LIVES,
    invuln: 0,
    speed: 0,
    walls: [], starsList: [],
    nextWall: 0,
    lastCenter: 0.5,
    flap: 0
  };

  const r = () => Math.min(W, H) * 0.035;
  const top = () => H * 0.1;
  const bottom = () => H - r() - 6;
  const levelToY = (lv) => bottom() - lv * (bottom() - top());

  function measure(ms) {
    const samples = [];
    const t0 = performance.now();
    return new Promise((res) => {
      const tick = () => {
        samples.push(micDb());
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else res(samples.sort((a, b) => a - b));
      };
      tick();
    });
  }

  g.start = async () => {
    g.y = g.prevY = bottom();
    g.nextWall = W * 0.7;
    showOverlay('<h2>🐤 こえでとべ！</h2><p>声の大きさがそのまま高さになります。<br>大きい声ほど高く、だまると地面へ。</p><p>マイクを準備しています…</p>');
    try {
      await ensureMic();
      g.useMic = true;
      showOverlay('<h2>しずかに…</h2><p>まわりの音の大きさを測っています</p>');
      const quiet = await measure(1200);
      const floor = quiet[Math.floor(quiet.length * 0.7)];
      showOverlay('<h2>「あーーー！」</h2><p>いちばん大きな声を3秒出してください</p>');
      const loud = await measure(3000);
      const peak = loud[Math.floor(loud.length * 0.8)];
      // Low end sits just above cabin noise; high end a bit under the user's shout so the sky is reachable
      g.low = floor + 6;
      g.high = Math.max(g.low + 12, peak - 3);
    } catch (err) {
      g.useMic = false;
      notice('マイクが使えないので、指で上下になぞって遊べます（' + errName(err) + '）', 6000);
    }
    const hint = g.useMic ? '声の大きさで高さを合わせてゲートをくぐろう' : '指を上下に動かして高さを合わせよう';
    let n = 3;
    showOverlay(`<h2>${n}</h2><p>${hint}</p>`);
    const iv = setInterval(() => {
      n--;
      if (n > 0) showOverlay(`<h2>${n}</h2><p>${hint}</p>`);
      else { clearInterval(iv); hideOverlay(); g.paused = false; g.waiting = false; }
    }, 700);
  };

  g.update = (dt) => {
    let lv = g.level;
    if (g.useMic) lv = clamp((micDb() - g.low) / (g.high - g.low), 0, 1);
    // Touch: finger height is the target height (works alongside the mic)
    if (pointer.down) lv = clamp((bottom() - pointer.y) / (bottom() - top()), 0, 1);
    // Rise quickly, fall a little slower so short breaths don't drop you to the ground
    const k = lv > g.level ? 10 : 4;
    g.level += (lv - g.level) * Math.min(1, dt * k);

    g.prevY = g.y;
    g.y = levelToY(g.level);
    g.flap += dt * (4 + g.level * 14);
    g.invuln = Math.max(0, g.invuln - dt);

    g.speed = W * (0.17 + Math.min(0.15, g.dist / 6000));
    g.dist += g.speed * dt / (W * 0.01);

    // Gates: the opening narrows over time and moves gradually so it can be followed by voice
    g.nextWall -= g.speed * dt;
    if (g.nextWall <= 0) {
      const gapN = clamp(0.4 - g.gates * 0.006, 0.24, 0.4);
      const maxStep = clamp(0.25 + g.gates * 0.01, 0.25, 0.5);
      const center = clamp(g.lastCenter + rand(-maxStep, maxStep), 0.1 + gapN / 2, 0.95 - gapN / 2);
      g.lastCenter = center;
      const cy = levelToY(center);
      const gap = gapN * (bottom() - top());
      g.walls.push({ x: W + 60, w: 70, top: cy - gap / 2, bot: cy + gap / 2, center, passed: false, broken: false });
      if (Math.random() < 0.6) g.starsList.push({ x: W + 95, y: cy, got: false });
      g.nextWall = W * rand(0.55, 0.7);
    }
    const bx = W * 0.22, rr = r();
    for (const w of g.walls) w.x -= g.speed * dt;
    for (const s of g.starsList) s.x -= g.speed * dt;
    g.walls = g.walls.filter((w) => w.x + w.w > -20);
    g.starsList = g.starsList.filter((s) => s.x > -20 && !s.got);

    for (const s of g.starsList) {
      if (Math.hypot(s.x - bx, s.y - g.y) < rr * 2) { s.got = true; g.stars++; }
    }
    for (const w of g.walls) {
      const inside = bx + rr > w.x && bx - rr < w.x + w.w;
      if (inside && !w.broken && g.invuln <= 0 && (g.y - rr < w.top || g.y + rr > w.bot)) {
        // A hit costs a life and breaks this gate so you aren't hit twice by it
        w.broken = true;
        g.lives--;
        g.invuln = 1.5;
        notice('いたっ！ のこり ' + g.lives, 1200);
        if (g.lives <= 0) {
          $('hud-right').textContent = '🤍'.repeat(LIVES) + '  ⭐ ' + g.stars;
          g.finish();
          return;
        }
      }
      if (!w.passed && w.x + w.w < bx - rr) {
        w.passed = true;
        if (!w.broken) g.gates++;
      }
    }

    $('hud-left').textContent = '🐤 ' + g.score() + ' 点';
    $('hud-right').textContent = '❤️'.repeat(g.lives) + '🤍'.repeat(LIVES - g.lives) + '  ⭐ ' + g.stars;
  };

  g.score = () => Math.floor(g.dist) + g.gates * 10 + g.stars * 20;

  g.finish = () => {
    if (g.over) return;
    g.over = true;
    g.paused = true;
    showResult(g, 'こえでとべ！', g.score(), null);
  };

  g.draw = (t) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1d3b6e');
    sky.addColorStop(1, '#5aa0d8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3f7d4e';
    ctx.fillRect(0, H - 6, W, 6);

    for (const w of g.walls) {
      ctx.globalAlpha = w.broken ? 0.35 : 1;
      ctx.fillStyle = '#f4f7ff';
      roundRect(w.x, -20, w.w, w.top + 20, 22);
      roundRect(w.x, w.bot, w.w, H - w.bot + 20, 22);
      ctx.fillStyle = '#ffd43b';
      ctx.fillRect(w.x - 6, w.top - 6, w.w + 12, 6);
      ctx.fillRect(w.x - 6, w.bot, w.w + 12, 6);
      ctx.globalAlpha = 1;
    }
    for (const s of g.starsList) drawStar(s.x, s.y, 16, t);

    // Chick (blinks while invulnerable)
    const bx = W * 0.22, rr = r();
    if (!(g.invuln > 0 && Math.floor(t / 100) % 2)) {
      ctx.save();
      ctx.translate(bx, g.y);
      ctx.rotate(clamp((g.y - g.prevY) / (H * 0.02), -0.5, 0.5));
      ctx.fillStyle = '#ffd43b';
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f5b800';
      ctx.beginPath(); ctx.ellipse(-rr * 0.2, rr * 0.1, rr * 0.55, rr * 0.3 * (0.6 + Math.abs(Math.sin(g.flap))), 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff7b00';
      ctx.beginPath(); ctx.moveTo(rr * 0.85, -rr * 0.1); ctx.lineTo(rr * 1.4, rr * 0.05); ctx.lineTo(rr * 0.85, rr * 0.25); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(rr * 0.4, -rr * 0.3, rr * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Voice meter on the same scale as the screen, with the next gate's opening marked
    const mx = 16, mw = 22, mt = top() - rr, mb = bottom() + rr;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(mx, mt, mw, mb - mt, 11);
    const next = g.walls.find((w) => !w.passed && !w.broken && w.x + w.w > bx - rr);
    if (next) {
      ctx.fillStyle = 'rgba(255,212,59,0.45)';
      ctx.fillRect(mx - 4, next.top, mw + 8, next.bot - next.top);
    }
    ctx.fillStyle = '#22c3a6';
    ctx.beginPath(); ctx.arc(mx + mw / 2, g.y, 9, 0, Math.PI * 2); ctx.fill();
  };

  return g;
}

// ---------- Game 2: パクパクキャッチ (camera) ----------
const FRUITS = [
  { e: '🍎', c: '#e53935' }, { e: '🍊', c: '#fb8c00' }, { e: '🍇', c: '#8e24aa' },
  { e: '🍓', c: '#d81b60' }, { e: '🍌', c: '#fdd835' }, { e: '🍉', c: '#43a047' }
];

let landmarkerPromise = null;
function loadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import('./vendor/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: new URL('./vendor/face_landmarker.task', import.meta.url).href, delegate },
        runningMode: 'VIDEO',
        numFaces: 1
      });
      // CPU (XNNPACK) is steadier than WebGL across browsers and fast enough at 15 detections/s
      return await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

function FaceGame() {
  const DURATION = 60;
  const g = {
    key: 'face',
    again: () => FaceGame(),
    paused: true,
    waiting: true,
    over: false,
    useCam: false,
    landmarker: null,
    lastVideoTime: -1,
    lastDetectAt: 0,
    mouth: { x: 0, y: 0, open: false, openness: 0, seen: false },
    lastFaceAt: 0,
    items: [],
    spawn: 0,
    time: DURATION,
    score: 0,
    combo: 0,
    pops: [],
    flash: 0
  };

  const switchToTouch = (msg) => {
    g.useCam = false;
    video.style.display = 'none';
    notice(msg + ' タッチで遊べます（指の位置で口が動きます）', 6000);
  };

  g.start = async () => {
    g.mouth.x = W / 2; g.mouth.y = H * 0.7;
    showOverlay('<h2>😮 パクパクキャッチ</h2><p>顔を動かして、口を開けてフルーツをパクッ！<br>ピーマンは口を閉じてよけてね。</p><p>カメラを準備しています…</p>');
    try {
      await ensureCam();
      showOverlay('<h2>😮 パクパクキャッチ</h2><p>顔認識を読み込み中…（初回は少し時間がかかります）</p>');
      g.landmarker = await loadLandmarker();
      g.useCam = true;
      video.style.display = 'block';
      onCamLost = () => { if (current === g) switchToTouch('走行を始めたのでカメラが止まりました。'); };
    } catch (err) {
      g.useCam = false;
      stopCam();
      notice('カメラが使えません（停車中・対応車のみ）: ' + errName(err) + '。タッチで遊べます', 7000);
    }
    let n = 3;
    const msg = g.useCam ? '顔が画面に映るようにしてね' : '指でなぞって口を動かそう';
    showOverlay(`<h2>${n}</h2><p>${msg}</p>`);
    const iv = setInterval(() => {
      n--;
      if (n > 0) showOverlay(`<h2>${n}</h2><p>${msg}</p>`);
      else { clearInterval(iv); hideOverlay(); g.paused = false; g.waiting = false; }
    }, 700);
  };

  g.stop = () => { onCamLost = null; };

  function track(now) {
    if (!g.useCam || !g.landmarker || video.readyState < 2) return;
    // ~15 detections/s is plenty for steering and keeps slower GPUs responsive
    if (video.currentTime === g.lastVideoTime || now - g.lastDetectAt < 66) return;
    g.lastVideoTime = video.currentTime;
    g.lastDetectAt = now;
    let res;
    try { res = g.landmarker.detectForVideo(video, now); } catch (e) { return; }
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) return;
    g.lastFaceAt = now;
    // Inner lips 13/14, mouth corners 61/291
    const up = lm[13], lo = lm[14], l = lm[61], r = lm[291];
    const open = Math.hypot(up.x - lo.x, up.y - lo.y) / Math.max(0.001, Math.hypot(l.x - r.x, l.y - r.y));
    const p = videoToScreen((up.x + lo.x) / 2, (up.y + lo.y) / 2);
    // Exaggerate head motion so small movements cover the whole screen
    const tx = clamp(W / 2 + (p.x - W / 2) * 1.8, 0, W);
    const ty = clamp(H / 2 + (p.y - H / 2) * 1.6, H * 0.15, H);
    g.mouth.x += (tx - g.mouth.x) * 0.5;
    g.mouth.y += (ty - g.mouth.y) * 0.5;
    g.mouth.openness = open;
    g.mouth.open = open > 0.25;
    g.mouth.seen = true;
  }

  // Map normalized video coords to screen coords for a mirrored, object-fit: cover video
  function videoToScreen(nx, ny) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    const x = (1 - nx) * dw - (dw - W) / 2;
    const y = ny * dh - (dh - H) / 2;
    return { x, y };
  }

  g.update = (dt, now) => {
    if (g.useCam) {
      track(now);
      if (now - g.lastFaceAt > 1500) notice('顔が見えません。カメラの方を向いてね', 800);
    } else if (pointer.seen) {
      g.mouth.x += (pointer.x - g.mouth.x) * 0.4;
      g.mouth.y += (pointer.y - g.mouth.y) * 0.4;
      g.mouth.open = true;
      g.mouth.seen = true;
    }

    g.time -= dt;
    if (g.time <= 0) { g.time = 0; g.finish(); return; }

    const elapsed = DURATION - g.time;
    g.spawn -= dt;
    if (g.spawn <= 0) {
      const roll = Math.random();
      const kind = roll < 0.18 ? 'bad' : roll < 0.25 ? 'gold' : 'fruit';
      g.items.push({
        kind,
        f: FRUITS[Math.floor(Math.random() * FRUITS.length)],
        x: rand(W * 0.08, W * 0.92),
        y: -40,
        vy: H * rand(0.18, 0.28) * (1 + elapsed / 50),
        rot: rand(0, Math.PI * 2),
        vr: rand(-2, 2)
      });
      g.spawn = Math.max(0.35, 1.0 - elapsed / 80);
    }

    const R = Math.min(W, H) * 0.09;
    for (const it of g.items) {
      it.y += it.vy * dt;
      it.rot += it.vr * dt;
      if (!it.done && g.mouth.seen && g.mouth.open && Math.hypot(it.x - g.mouth.x, it.y - g.mouth.y) < R) {
        it.done = true;
        if (it.kind === 'bad') {
          g.score = Math.max(0, g.score - 30);
          g.combo = 0;
          g.flash = 0.4;
          g.pops.push({ x: it.x, y: it.y, text: '-30 にがい！', c: '#ef4444', life: 1 });
        } else {
          g.combo++;
          const pts = (it.kind === 'gold' ? 50 : 10) + Math.min(5, g.combo - 1) * 2;
          g.score += pts;
          g.pops.push({ x: it.x, y: it.y, text: '+' + pts + (g.combo > 2 ? ' ' + g.combo + 'コンボ' : ''), c: '#fff', life: 1 });
        }
      }
      if (!it.done && it.y > H + 40 && it.kind !== 'bad') g.combo = 0;
    }
    g.items = g.items.filter((it) => !it.done && it.y < H + 60);
    for (const p of g.pops) { p.life -= dt; p.y -= 60 * dt; }
    g.pops = g.pops.filter((p) => p.life > 0);
    g.flash = Math.max(0, g.flash - dt);

    $('hud-left').textContent = '😮 ' + g.score + ' 点';
    $('hud-right').textContent = '⏱ ' + Math.ceil(g.time);
  };

  g.finish = () => {
    if (g.over) return;
    g.over = true;
    g.paused = true;
    onCamLost = null;
    const photo = snapshot('パクパクキャッチ', g.score);
    showResult(g, 'パクパクキャッチ', g.score, photo);
  };

  g.draw = (t) => {
    if (!g.useCam) {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#2b1a3d');
      bg.addColorStop(1, '#5b2c3a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    const R = Math.min(W, H) * 0.05;
    for (const it of g.items) {
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rot);
      if (it.kind === 'bad') drawPepper(R);
      else if (it.kind === 'gold') drawStar(0, 0, R, t);
      else drawFruit(it.f, R);
      ctx.restore();
    }

    // Mouth marker
    if (g.mouth.seen) {
      const mr = Math.min(W, H) * 0.09;
      ctx.lineWidth = 6;
      ctx.strokeStyle = g.mouth.open ? '#ff8a3d' : 'rgba(255,255,255,0.6)';
      ctx.fillStyle = g.mouth.open ? 'rgba(255,138,61,0.25)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      if (g.mouth.open) ctx.arc(g.mouth.x, g.mouth.y, mr, 0, Math.PI * 2);
      else ctx.ellipse(g.mouth.x, g.mouth.y, mr, mr * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(g.mouth.open ? 'パク！' : '…', g.mouth.x, g.mouth.y - mr - 10);
    }

    for (const p of g.pops) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.c;
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    if (g.flash > 0) {
      ctx.fillStyle = `rgba(239,68,68,${g.flash})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  return g;
}

// ---------- Drawing helpers ----------
function roundRect(x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}

function drawStar(x, y, r, t) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t / 600);
  ctx.fillStyle = '#ffe066';
  ctx.strokeStyle = '#f59f00';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Colored disc first so the item still reads if the car's browser lacks emoji fonts
function drawFruit(f, r) {
  ctx.fillStyle = f.c;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.35, r * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.font = `${r * 1.5}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(f.e, 0, r * 0.08);
  ctx.textBaseline = 'alphabetic';
}

function drawPepper(r) {
  ctx.fillStyle = '#2e7d32';
  ctx.beginPath(); ctx.ellipse(0, 0, r * 0.8, r, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1b5e20';
  ctx.fillRect(-r * 0.12, -r * 1.25, r * 0.24, r * 0.4);
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-r, -r); ctx.lineTo(r, r);
  ctx.moveTo(r, -r); ctx.lineTo(-r, r);
  ctx.stroke();
}

// ---------- Boot ----------
document.querySelectorAll('.game-card').forEach((card) => {
  card.addEventListener('click', () => {
    startGame(card.dataset.game === 'voice' ? VoiceGame() : FaceGame());
  });
});

$('env-note').textContent = window.isSecureContext && navigator.mediaDevices
  ? 'マイク・カメラは最初に許可を求められます。カメラは停車中のみ使えます。'
  : 'この環境ではマイク・カメラが使えません（HTTPSで開いてください）。タッチで遊べます。';

renderFame();
