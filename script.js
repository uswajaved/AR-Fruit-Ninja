const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const video = document.getElementById('webcam');
const overlay = document.getElementById('cameraOverlay');
const hud = document.getElementById('hud');
const gameControls = document.getElementById('gameControls');
const kaboomEffect = document.getElementById('kaboomEffect');

function handleTitleImgError(img) { img.style.display = 'none'; if (img.nextElementSibling) img.nextElementSibling.style.display = 'block'; }
function handleImgError(img) {
    const ring = img.closest('.ring-btn');
    if (ring) { ring.classList.add('img-missing'); return; }
    img.style.display = 'none';
    if (img.dataset.fallback && img.parentElement && !img.parentElement.querySelector('.icon-fallback')) {
        const span = document.createElement('span'); span.className = 'icon-fallback'; span.textContent = img.dataset.fallback; img.parentElement.appendChild(span);
    }
}
const handStatus = document.getElementById('handStatus');

let currentScreen = 1, selectedDifficulty = null, score = 0, lives = 3;
let gameRunning = false, paused = false, gameAnimationId = null, spawnTimer = null, gameOverTimer = null;
let nextEasyBombAt = 20;
let bestScore = Number(localStorage.getItem('fn_best_score')) || 0;
document.getElementById('bestScore').textContent = bestScore;

let soundEnabled = localStorage.getItem('fn_sound') !== 'off';
let musicEnabled = localStorage.getItem('fn_music') !== 'off';

function updateAudioIcons() {
    const soundIcon = document.getElementById('soundIcon'); const musicIcon = document.getElementById('musicIcon');
    soundIcon.dataset.fallback = soundEnabled ? '🔊' : '🔇'; musicIcon.dataset.fallback = musicEnabled ? '🎵' : '🔕';
    soundIcon.src = soundEnabled ? 'assets/Sound_on.png' : 'assets/Sound_off.png'; musicIcon.src = musicEnabled ? 'assets/Music_On.png' : 'assets/Music_Off.png';
}
function toggleSound() { soundEnabled = !soundEnabled; localStorage.setItem('fn_sound', soundEnabled ? 'on' : 'off'); updateAudioIcons(); }
function toggleMusic() { musicEnabled = !musicEnabled; localStorage.setItem('fn_music', musicEnabled ? 'on' : 'off'); updateAudioIcons(); if (musicEnabled) resumeMusicForScreen(currentScreen); else stopAllMusic(); }
updateAudioIcons();

const fruitTypes = ['Apple', 'Lemon', 'Banana', 'Orange', 'Pear'];
const assets = { Bomb: { whole: 'assets/Bomb.png' } };
fruitTypes.forEach(n => { assets[n] = { whole: `assets/${n}.png`, slice1: `assets/Sliced ${n} 1.png`, slice2: `assets/Sliced ${n} 2.png`, splash: `assets/${n} Splash.png` }; });

const imageCache = {};
function getImage(src) { if (!imageCache[src]) { const image = new Image(); image.src = src; imageCache[src] = image; } return imageCache[src]; }
Object.values(assets).forEach(a => Object.values(a).forEach(getImage));
const cutImg = getImage('assets/Cut with hand.png');
const plusIcon = getImage('assets/Plus.png');

let fruits = [], halves = [], splashes = [], sliceTrail = [], popups = [];
let comboCount = 0, comboTimer = null, comboX = 0, comboY = 0;

// Balanced fruit visual sizes (keeps natural aspect ratio)
const fruitSizeConfig = {
    Apple:  { height:120, collision:65 },
    Pear:   { height:115, collision:60 },
    Banana: { height:115, collision:62 },
    Orange: { height:95,  collision:50 },
    Lemon:  { height:80,  collision:42 }
};
const bombSizeConfig = { height:70, collision:35 };

function spawnPopup(text, x, y, bonus = 0, type = 'normal') {
    popups.push({ text, bonus, type, x, y, life: 80, maxLife: 80 });
}

function finalizeCombo() {
    if (comboCount >= 3) {
        spawnPopup(`FRUIT COMBO +${comboCount}`, comboX, comboY, comboCount * 10, 'combo');
    }
    comboCount = 0;
}

/* ========================================================= WEB AUDIO API ========================================================= */
let audioContext = null, masterGain = null, lastSwishAt = 0, lastAudioSlicePoint = null, lastLifeLostAt = 0;
const SWISH_COOLDOWN = 90, LIFE_LOST_COOLDOWN = 180;

function initAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioContextClass(); masterGain = audioContext.createGain(); masterGain.gain.value = 0.62; masterGain.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
}
function audioDestination(audio) { return masterGain || audio.destination; }
function createNoiseBuffer(audio, duration, envelopeFn) {
    const frameCount = Math.max(1, Math.ceil(audio.sampleRate * duration)); const buffer = audio.createBuffer(1, frameCount, audio.sampleRate); const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) { data[i] = (Math.random() * 2 - 1) * envelopeFn(i / frameCount); } return buffer;
}

function playSwordSwish(speed = 1) {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const nowMs = performance.now(); if (nowMs - lastSwishAt < SWISH_COOLDOWN) return; lastSwishAt = nowMs;
    const now = audio.currentTime; speed = Math.max(0.4, Math.min(speed, 3));
    const duration = Math.max(0.09, Math.min(0.20, 0.19 - speed * 0.025)); const volume = Math.max(0.035, Math.min(0.105, 0.035 + speed * 0.022));
    const source = audio.createBufferSource(); source.buffer = createNoiseBuffer(audio, duration, p => Math.sin(p * Math.PI));
    const bandpass = audio.createBiquadFilter(); bandpass.type = 'bandpass'; bandpass.Q.value = 0.85;
    bandpass.frequency.setValueAtTime(700 + speed * 180, now); bandpass.frequency.exponentialRampToValueAtTime(2300 + speed * 850, now + duration * 0.55); bandpass.frequency.exponentialRampToValueAtTime(900 + speed * 200, now + duration);
    const highpass = audio.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 350;
    const gain = audio.createGain(); gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(volume, now + 0.012); gain.gain.exponentialRampToValueAtTime(volume * 0.55, now + duration * 0.52); gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    const panner = audio.createStereoPanner(); panner.pan.setValueAtTime((Math.random() * 0.7) - 0.35, now); panner.pan.linearRampToValueAtTime((Math.random() * 0.7) - 0.35, now + duration);
    source.connect(bandpass); bandpass.connect(highpass); highpass.connect(gain); gain.connect(panner); panner.connect(audioDestination(audio));
    source.start(now); source.stop(now + duration + 0.03);
}
function handleSwordMovement(x, y) {
    const now = performance.now();
    if (!lastAudioSlicePoint) { lastAudioSlicePoint = { x, y, time: now }; return; }
    const dx = x - lastAudioSlicePoint.x, dy = y - lastAudioSlicePoint.y, distance = Math.hypot(dx, dy), elapsed = Math.max(1, now - lastAudioSlicePoint.time);
    if (distance >= 12) { const speed = (distance / elapsed) * 16.67; playBladeMoveSound(speed); }
    lastAudioSlicePoint = { x, y, time: now };
}
function playSwordStrike() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const now = audio.currentTime, strikeDuration = 0.12, variation = (Math.random() - 0.5) * 120;
    const bladeTone = audio.createOscillator(), bladeGain = audio.createGain(), bladeFilter = audio.createBiquadFilter();
    bladeTone.type = 'triangle'; bladeTone.frequency.setValueAtTime(1550 + variation, now); bladeTone.frequency.exponentialRampToValueAtTime(720 + variation * 0.25, now + strikeDuration);
    bladeFilter.type = 'highpass'; bladeFilter.frequency.value = 500;
    bladeGain.gain.setValueAtTime(0.0001, now); bladeGain.gain.exponentialRampToValueAtTime(0.12, now + 0.004); bladeGain.gain.exponentialRampToValueAtTime(0.0001, now + strikeDuration);
    bladeTone.connect(bladeFilter); bladeFilter.connect(bladeGain); bladeGain.connect(audioDestination(audio));
    bladeTone.start(now); bladeTone.stop(now + strikeDuration + 0.02);
}
function playBombExplosion() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const now = audio.currentTime, boomDuration = 0.85;
    const bass = audio.createOscillator(), bassGain = audio.createGain();
    bass.type = 'sine'; bass.frequency.setValueAtTime(145, now); bass.frequency.exponentialRampToValueAtTime(38, now + 0.28);
    bassGain.gain.setValueAtTime(0.0001, now); bassGain.gain.exponentialRampToValueAtTime(0.33, now + 0.012); bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    bass.connect(bassGain); bassGain.connect(audioDestination(audio)); bass.start(now); bass.stop(now + 0.56);
    const noiseSource = audio.createBufferSource(); noiseSource.buffer = createNoiseBuffer(audio, boomDuration, p => Math.pow(1 - p, 2.3));
    const explosionFilter = audio.createBiquadFilter(); explosionFilter.type = 'lowpass'; explosionFilter.Q.value = 0.7; explosionFilter.frequency.setValueAtTime(5000, now); explosionFilter.frequency.exponentialRampToValueAtTime(280, now + boomDuration);
    const explosionGain = audio.createGain(); explosionGain.gain.setValueAtTime(0.0001, now); explosionGain.gain.exponentialRampToValueAtTime(0.25, now + 0.008); explosionGain.gain.exponentialRampToValueAtTime(0.0001, now + boomDuration);
    noiseSource.connect(explosionFilter); explosionFilter.connect(explosionGain); explosionGain.connect(audioDestination(audio)); noiseSource.start(now); noiseSource.stop(now + boomDuration + 0.03);
}
function playLifeLostSound() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const nowMs = performance.now(); if (nowMs - lastLifeLostAt < LIFE_LOST_COOLDOWN) return; lastLifeLostAt = nowMs;
    const now = audio.currentTime;
    const bufferSize = audio.sampleRate * 0.2; const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate); const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) { data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2); }
    const noiseSrc = audio.createBufferSource(); noiseSrc.buffer = buffer;
    const noiseFilter = audio.createBiquadFilter(); noiseFilter.type = 'highpass'; noiseFilter.frequency.value = 1500;
    const noiseGain = audio.createGain(); noiseGain.gain.setValueAtTime(0.3, now); noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    noiseSrc.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(audioDestination(audio)); noiseSrc.start(now); noiseSrc.stop(now + 0.2);
    const osc = audio.createOscillator(), oscGain = audio.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(600, now); osc.frequency.exponentialRampToValueAtTime(100, now + 0.3);
    oscGain.gain.setValueAtTime(0.2, now); oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(oscGain); oscGain.connect(audioDestination(audio)); osc.start(now); osc.stop(now + 0.3);
}
function playGameOverSound() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const now = audio.currentTime, duration = 1.05;
    const notes = [{ start: 420, end: 180, delay: 0.00, volume: 0.13 }, { start: 300, end: 95, delay: 0.18, volume: 0.14 }];
    notes.forEach(note => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), filter = audio.createBiquadFilter();
        oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(note.start, now + note.delay); oscillator.frequency.exponentialRampToValueAtTime(note.end, now + note.delay + 0.55);
        filter.type = 'lowpass'; filter.frequency.value = 1300;
        gain.gain.setValueAtTime(0.0001, now + note.delay); gain.gain.exponentialRampToValueAtTime(note.volume, now + note.delay + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, now + note.delay + 0.72);
        oscillator.connect(filter); filter.connect(gain); gain.connect(audioDestination(audio)); oscillator.start(now + note.delay); oscillator.stop(now + note.delay + 0.76);
    });
    const thud = audio.createOscillator(), thudGain = audio.createGain();
    thud.type = 'sine'; thud.frequency.setValueAtTime(105, now + 0.36); thud.frequency.exponentialRampToValueAtTime(42, now + duration);
    thudGain.gain.setValueAtTime(0.0001, now + 0.36); thudGain.gain.exponentialRampToValueAtTime(0.15, now + 0.38); thudGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    thud.connect(thudGain); thudGain.connect(audioDestination(audio)); thud.start(now + 0.36); thud.stop(now + duration + 0.03);
}
const dropSoundSrc = new Audio('assets/Dropping_-_universfield-impact-thud-291047.mp3'); dropSoundSrc.preload = 'auto';
function playDropSound() { if (!soundEnabled) return; const s = dropSoundSrc.cloneNode(); s.volume = 0.22; s.play().catch(() => {}); }

const fruitSlicedSrc = new Audio('assets/Fruit_sliced-mixkit-swift-sword-strike-2166.wav');
const kaboomAudioSrc = new Audio('assets/Kaboom-mixkit-fuel-explosion-1705.wav');
const bladeMoveSrc = new Audio('assets/balde_moving_-mixkit-sword-blade-swish-1506.wav');
[fruitSlicedSrc, kaboomAudioSrc, bladeMoveSrc].forEach(a => a.preload = 'auto');

function playClip(src, volume = 0.6, rate = 1) {
    if (!soundEnabled) return; const clip = src.cloneNode(); clip.playbackRate = rate;
    if (volume > 1) {
        const audio = initAudio(); if (audio) {
            try { const source = audio.createMediaElementSource(clip); const gain = audio.createGain(); gain.gain.value = volume; source.connect(gain); gain.connect(audioDestination(audio)); clip.play().catch(() => {}); return; } catch (err) {}
        } clip.volume = 1;
    } else { clip.volume = volume; }
    clip.play().catch(() => {});
}

let buttonSoundBuffer = null;
async function preloadButtonSoundWebAudio() {
    try {
        const response = await fetch('assets/Button-dragon-studio-button-press-2-386176.mp3');
        const arrayBuffer = await response.arrayBuffer();
        const tempAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        buttonSoundBuffer = await tempAudioCtx.decodeAudioData(arrayBuffer);
        tempAudioCtx.close();
    } catch (e) { console.warn('Failed to preload button sound for Web Audio API', e); }
}
preloadButtonSoundWebAudio();

function playButtonSound() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    if (buttonSoundBuffer) {
        const source = audio.createBufferSource(); source.buffer = buttonSoundBuffer; const gain = audio.createGain(); gain.gain.value = 0.5;
        source.connect(gain); gain.connect(audioDestination(audio)); source.start(0);
    } else {
        const now = audio.currentTime; const osc = audio.createOscillator(); const gain = audio.createGain();
        osc.type = 'square'; osc.frequency.setValueAtTime(800, now); osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
        gain.gain.setValueAtTime(0.2, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        osc.connect(gain); gain.connect(audioDestination(audio)); osc.start(now); osc.stop(now + 0.06);
    }
}

function playFruitSlicedSound() { playClip(fruitSlicedSrc, 0.45); }

// SPATIAL AUDIO KABOOM
function playKaboomSound(xPos) {
    if (!soundEnabled) return;
    const audio = initAudio();
    if (!audio) return;

    const panValue = (xPos / gameWidth()) * 2 - 1; // -1 (left) to 1 (right)
    const clip = kaboomAudioSrc.cloneNode();
    try {
        const source = audio.createMediaElementSource(clip);
        const gain = audio.createGain();
        gain.gain.value = 1.10;

        const panner = audio.createStereoPanner();
        panner.pan.value = panValue;

        source.connect(gain);
        gain.connect(panner);
        panner.connect(audioDestination(audio));
        clip.play().catch(() => {});
    } catch (err) {
        clip.volume = 1.0;
        clip.play().catch(() => {});
    }
}

function playBladeMoveSound(speed = 1) {
    const nowMs = performance.now(); if (nowMs - lastSwishAt < SWISH_COOLDOWN) return; lastSwishAt = nowMs;
    const rate = Math.max(0.85, Math.min(1.3, 0.9 + speed * 0.15)); playClip(bladeMoveSrc, 0.35, rate);
}

document.addEventListener('pointerdown', e => { if (e.target.closest('button, .ring-btn, .s2-back')) playButtonSound(); });

function playCriticalSound() {
    if (!soundEnabled) return; const audio = initAudio(); if (!audio) return;
    const now = audio.currentTime; const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(500, now); osc.frequency.exponentialRampToValueAtTime(1150, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain); gain.connect(audioDestination(audio)); osc.start(now); osc.stop(now + 0.24);
}

/* ===== BACKGROUND MUSIC ===== */
const menuMusic = new Audio('assets/Game_music_-_echoes_of_lumen-zen-music-595725.mp3'); menuMusic.loop = true; menuMusic.volume = 0.35;
const gameplayMusic = new Audio('assets/Background_music_-_loswin23-forest-birds-and-river-585677.mp3'); gameplayMusic.loop = true; gameplayMusic.volume = 0.3;
function playMenuMusic() { gameplayMusic.pause(); if (musicEnabled) menuMusic.play().catch(() => {}); }
function playGameplayMusic() { menuMusic.pause(); if (musicEnabled) gameplayMusic.play().catch(() => {}); }
function stopAllMusic() { menuMusic.pause(); gameplayMusic.pause(); }
function resumeMusicForScreen(n) { if (!musicEnabled) return; if (n === 3) { if (!paused) playGameplayMusic(); } else { playMenuMusic(); } }

function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr; canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas); resizeCanvas();
const gameWidth = () => window.innerWidth;
const gameHeight = () => window.innerHeight;

/* ===== SCREEN MANAGEMENT ===== */
function goToScreen(n) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const next = document.getElementById(`screen${n}`); if (next) next.classList.add('active');
    currentScreen = n;
    overlay.classList.toggle('visible', n === 1);
    hud.classList.toggle('active', n === 3 || n === 6);
    hud.classList.toggle('faded', n === 6);
    gameControls.classList.toggle('active', n === 3);
    handStatus.classList.toggle('show', ![2, 7, 8].includes(n));
    if (n === 8) updateAudioIcons();
    if (n !== 3) ctx.clearRect(0, 0, gameWidth(), gameHeight());
    resumeMusicForScreen(n);
}
goToScreen(1);

function selectDifficulty(level) {
    initAudio();
    selectedDifficulty = level;
    document.getElementById('levelIcon').src = `assets/${level === 'easy' ? 'Orange' : level === 'medium' ? 'Pear' : 'Bomb'}.png`;
    startCountdown();
}

function startCountdown() {
    goToScreen(4);
    setTimeout(() => { goToScreen(5); setTimeout(startGame, 900); }, 1000);
}

function startGame() {
    stopGameTimers(); score = 0; lives = 3; paused = false; nextEasyBombAt = 20;
    fruits = []; halves = []; splashes = []; sliceTrail = []; popups = []; comboCount = 0; clearTimeout(comboTimer);
    lastAudioSlicePoint = null; lastSwishAt = 0; lastLifeLostAt = 0;
    document.getElementById('scoreValue').textContent = score;
    document.getElementById('pauseIcon').src = 'assets/Pause.png';
    updateLives(); gameRunning = true; goToScreen(3); scheduleNextFruit(); gameLoop();
}

function togglePause() {
    if (!gameRunning) return; paused = !paused;
    document.getElementById('pauseIcon').src = paused ? 'assets/Play.png' : 'assets/Pause.png';
    if (paused) {
        if (gameAnimationId) { cancelAnimationFrame(gameAnimationId); gameAnimationId = null; }
        if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
        lastAudioSlicePoint = null; gameplayMusic.pause();
    } else { resumeMusicForScreen(3); gameLoop(); scheduleNextFruit(); }
}

function speedFactor() { if (selectedDifficulty === 'easy') return 1; return Math.min(1.6, 1 + Math.floor(score / 10) * 0.03); }
function spawnWave() {
    // Rare special combo wave (normal gameplay remains original)
    const comboWave = Math.random() < 0.12;

    if (comboWave) {
        const count = Math.floor(Math.random() * 3) + 3; // 3-5 fruits
        for (let i = 0; i < count; i++) setTimeout(spawnFruit, i * 120);
    } else {
        spawnFruit();
    }
}
function scheduleNextFruit() {
    if (!gameRunning || paused) return;
    let delay = 1800; if (selectedDifficulty === 'medium') delay = 1200; if (selectedDifficulty === 'hard') delay = 1600;
    spawnTimer = setTimeout(() => { spawnWave(); scheduleNextFruit(); }, delay / speedFactor());
}
function spawnFruit() {
    if (!gameRunning || paused) return;
    let isBomb;
    if (selectedDifficulty === 'easy') { isBomb = score >= nextEasyBombAt; if (isBomb) nextEasyBombAt = (Math.floor(score / 20) + 1) * 20; }
    else { isBomb = Math.random() < (selectedDifficulty === 'hard' ? 0.30 : 0.15); }
    const fruitName = fruitTypes[Math.floor(Math.random() * fruitTypes.length)];
    let upwardSpeed = 16; if (selectedDifficulty === 'easy') upwardSpeed = 14; if (selectedDifficulty === 'hard') upwardSpeed = 19;
    const source = isBomb ? assets.Bomb.whole : assets[fruitName].whole;
    fruits.push({
        name: fruitName, isBomb, img: getImage(source),
        x: 120 + Math.random() * Math.max(1, gameWidth() - 240), y: gameHeight() + 80,
        vx: (Math.random() - .5) * 5, vy: -(upwardSpeed + Math.random() * 4) * speedFactor(),
        rotation: Math.random() * Math.PI * 2, rotationSpeed: (Math.random() - .5) * .08,
        displayHeight: isBomb ? bombSizeConfig.height : fruitSizeConfig[fruitName].height,
        radius: isBomb ? bombSizeConfig.collision : fruitSizeConfig[fruitName].collision,
        sliced: false, criticalDone: false
    });
}

let pointerIsDown = false, lastPointerPoint = null;
window.addEventListener('pointerdown', e => {
    initAudio(); resumeMusicForScreen(currentScreen);
    if (!gameRunning || paused) return; if (e.target.closest('button, .ring-btn')) return;
    pointerIsDown = true; lastPointerPoint = { x: e.clientX, y: e.clientY }; addSlicePoint(e.clientX, e.clientY);
}, { passive: true });
window.addEventListener('pointermove', e => {
    if (!gameRunning || paused || !pointerIsDown) return; const p = { x: e.clientX, y: e.clientY }; addSliceSegment(lastPointerPoint, p); lastPointerPoint = p;
}, { passive: true });
function stopPointerSlice() { pointerIsDown = false; lastPointerPoint = null; lastAudioSlicePoint = null; }
window.addEventListener('pointerup', stopPointerSlice, { passive: true });
window.addEventListener('pointercancel', stopPointerSlice, { passive: true });
window.addEventListener('pointerleave', stopPointerSlice, { passive: true });
function addSliceSegment(start, end) {
    if (!start || !end) return; const dist = Math.hypot(end.x - start.x, end.y - start.y); const steps = Math.max(1, Math.ceil(dist / 12));
    for (let i = 1; i <= steps; i++) { const t = i / steps; addSlicePoint(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t); }
}
function addSlicePoint(x, y) {
    if (!gameRunning || paused) return; handleSwordMovement(x, y); sliceTrail.push({ x, y, life: 16 });
    if (sliceTrail.length > 35) sliceTrail.shift(); checkSlice(x, y);
}

// RAYCASTING HELPER
function lineIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
    const distX = x1 - x2; const distY = y1 - y2; const lenSq = distX * distX + distY * distY;
    if (lenSq === 0) return Math.hypot(x1 - cx, y1 - cy) <= r;
    let t = ((cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1)) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = x1 + t * (x2 - x1); const closestY = y1 + t * (y2 - y1);
    return Math.hypot(cx - closestX, cy - closestY) <= r;
}

// CONTINUOUS COLLISION CHECK
function checkSlice(x, y) {
    if (!gameRunning || paused) return;
    const prevPoint = sliceTrail.length > 0 ? sliceTrail[sliceTrail.length - 1] : { x, y };
    for (const fruit of fruits) {
        if (fruit.sliced) continue;
        if (lineIntersectsCircle(prevPoint.x, prevPoint.y, x, y, fruit.x, fruit.y, fruit.radius + 25)) {
            sliceFruit(fruit, prevPoint.x, prevPoint.y, x, y);
        } else if (fruit.isBomb && !fruit.criticalDone) {
            if (lineIntersectsCircle(prevPoint.x, prevPoint.y, x, y, fruit.x, fruit.y, fruit.radius + 15)) {
                fruit.criticalDone = true; score += 30; document.getElementById('scoreValue').textContent = score;
                spawnPopup('CRITICAL', x, y - 10, 30, 'critical'); playCriticalSound();
            }
        }
    }
}

// PROCEDURAL SLICING
function sliceFruit(fruit, sliceX1, sliceY1, sliceX2, sliceY2) {
    if (fruit.sliced) return;
    fruit.sliced = true;

    if (fruit.isBomb) {
        playKaboomSound(fruit.x);

        if (selectedDifficulty === 'easy') { lives--; updateLives(); }
        const ends = selectedDifficulty !== 'easy' || lives <= 0;
        showKaboom(ends);
        if (ends) setTimeout(gameOver, 900);
        return;
    }

    playFruitSlicedSound();
    comboCount++;
    let sliceBonus = 10;
    if (comboCount >= 2) {
        const bonuses = {2:25,3:40,4:60,5:100};
        sliceBonus = bonuses[Math.min(comboCount,5)] || 10;
        spawnPopup(`FRUIT COMBO +${comboCount}`, fruit.x, fruit.y - 70, sliceBonus, 'combo');
    }
    score += sliceBonus; document.getElementById('scoreValue').textContent = score;

    // Exact angle the player swiped
    const sliceAngle = Math.atan2(sliceY2 - sliceY1, sliceX2 - sliceX1);

    comboX = fruit.x; comboY = fruit.y - 50; clearTimeout(comboTimer); comboTimer = setTimeout(finalizeCombo, 450);

    const a = assets[fruit.name];
    splashes.push({ img: getImage(a.splash), x: fruit.x, y: fruit.y, life: 150, maxLife: 150, angle: sliceAngle });

    // Push halves PERPENDICULAR to the slice angle
    const pushAngle1 = sliceAngle + Math.PI / 2;
    const pushAngle2 = sliceAngle - Math.PI / 2;

    halves.push({
        img: getImage(a.slice1), x: fruit.x, y: fruit.y,
        vx: fruit.vx + Math.cos(pushAngle1) * 4, vy: fruit.vy + Math.sin(pushAngle1) * 4 - 1,
        rotation: sliceAngle, rotationSpeed: -.12, displayHeight: fruit.displayHeight * 0.55
    });
    halves.push({
        img: getImage(a.slice2), x: fruit.x, y: fruit.y,
        vx: fruit.vx + Math.cos(pushAngle2) * 4, vy: fruit.vy + Math.sin(pushAngle2) * 4 - 1,
        rotation: sliceAngle, rotationSpeed: .12, displayHeight: fruit.displayHeight * 0.55
    });
}

/* ===== WEBCAM HAND TRACKING (MediaPipe) ===== */
let hands = null, camera = null, mediaPipeReady = false;
let lastHandSeenAt = 0, handFrameInFlight = false, smoothedHandPoint = null;
const HAND_SMOOTHING = 0.45;

function setHandStatus(text, mode) { handStatus.textContent = text; handStatus.classList.remove('tracking', 'warning', 'error'); if (mode) handStatus.classList.add(mode); }

async function setupMediaPipe() {
    setHandStatus('Starting camera…', 'warning');
    if (!window.isSecureContext) { setHandStatus('Camera blocked: open this via https:// or localhost, not by double-clicking the file — mouse/touch still works', 'error'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setHandStatus('Camera API unavailable in this browser — use mouse/touch to slice', 'error'); return; }
    try {
        if (typeof Hands === 'undefined' || typeof Camera === 'undefined') throw new Error('MediaPipe scripts failed to load');
        hands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}` });
        hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: .5, minTrackingConfidence: .5 });
        hands.onResults(onHandsResults);
        camera = new Camera(video, {
            onFrame: async () => { if (hands && !handFrameInFlight) { handFrameInFlight = true; try { await hands.send({ image: video }); } catch (err) {} finally { handFrameInFlight = false; } } },
            width: 640, height: 480
        });
        await camera.start(); mediaPipeReady = true; setHandStatus('Camera on — show your hand', 'warning'); setTimeout(checkHandTrackingHealth, 6000);
    } catch (error) {
        mediaPipeReady = false; let reason = 'Camera unavailable — use mouse/touch to slice';
        if (error && error.name === 'NotAllowedError') reason = 'Camera permission denied — allow it in your browser\'s site settings, then reload';
        else if (error && error.name === 'NotFoundError') reason = 'No camera found on this device — use mouse/touch to slice';
        else if (error && error.name === 'NotReadableError') reason = 'Camera is in use by another app — close it and reload';
        setHandStatus(reason, 'error');
    }
}
function checkHandTrackingHealth() {
    if (!mediaPipeReady) return;
    if (!kinectActive()) {
        const secs = (Date.now() - lastHandSeenAt) / 1000;
        if (lastHandSeenAt === 0 || secs > 6) { setHandStatus('No hand detected — check lighting/distance, or use mouse/touch', 'warning'); smoothedHandPoint = null; lastAudioSlicePoint = null; }
    }
    setTimeout(checkHandTrackingHealth, 4000);
}
function handPointToScreen(landmark) {
    const sw = gameWidth(), sh = gameHeight(); const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.max(sw / vw, sh / vh); const rw = vw * scale, rh = vh * scale; const cropX = (rw - sw) / 2, cropY = (rh - sh) / 2;
    const mirroredX = 1 - landmark.x; return { x: mirroredX * rw - cropX, y: landmark.y * rh - cropY };
}
function onHandsResults(results) {
    if (kinectActive()) return; // Kinect has priority when it is tracking a player
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;
    lastHandSeenAt = Date.now(); setHandStatus('Hand tracking ✓', 'tracking');
    if (!gameRunning || paused) return;
    const indexTip = results.multiHandLandmarks[0][8]; const raw = handPointToScreen(indexTip);
    if (!smoothedHandPoint) smoothedHandPoint = { x: raw.x, y: raw.y };
    else { smoothedHandPoint.x += (raw.x - smoothedHandPoint.x) * HAND_SMOOTHING; smoothedHandPoint.y += (raw.y - smoothedHandPoint.y) * HAND_SMOOTHING; }
    addSlicePoint(smoothedHandPoint.x, smoothedHandPoint.y);
}
setupMediaPipe();

function updateLives() {
    const container = document.getElementById('livesContainer');
    while (container.children.length < 3) { const img = document.createElement('img'); img.src = 'assets/Life.png'; img.className = 'life-icon'; container.appendChild(img); }
    while (container.children.length > 3) container.removeChild(container.lastChild);
    const hearts = container.children;
    for (let i = 0; i < hearts.length; i++) {
        if (i < lives) { hearts[i].classList.remove('lost-life'); void hearts[i].offsetWidth; }
        else { if (!hearts[i].classList.contains('lost-life')) { hearts[i].classList.add('lost-life'); playLifeLostSound(); } }
    }
}

function gameLoop() {
    if (!gameRunning || paused) return; ctx.clearRect(0, 0, gameWidth(), gameHeight());
    updateWholeFruits(); updateHalves(); drawSplashes(); drawPopups(); drawSliceTrail();
    if (gameRunning && !paused) gameAnimationId = requestAnimationFrame(gameLoop);
}

function updateWholeFruits() {
    const gravity = .28;
    fruits = fruits.filter(fruit => {
        if (fruit.sliced) return false;
        fruit.x += fruit.vx; fruit.y += fruit.vy; fruit.vy += gravity; fruit.rotation += fruit.rotationSpeed;
        drawImageFixedHeight(fruit.img, fruit.x, fruit.y, fruit.displayHeight, fruit.rotation);
        if (fruit.y > gameHeight() + 120) {
            if (fruit.isBomb) playDropSound();
            else if (selectedDifficulty !== 'easy') { lives--; updateLives(); if (lives <= 0) gameOver(); }
            return false;
        }
        return true;
    });
}
function updateHalves() {
    const gravity = .32, halfHeight = 85;
    halves = halves.filter(half => {
        half.x += half.vx; half.y += half.vy; half.vy += gravity; half.rotation += half.rotationSpeed;
        drawImageFixedHeight(half.img, half.x, half.y, half.displayHeight || halfHeight, half.rotation);
        if (half.y >= gameHeight() + 150) { playDropSound(); return false; }
        return true;
    });
}
function drawPopups() {
    popups = popups.filter(p => {
        const progress = 1 - p.life / p.maxLife; const alpha = p.life > 14 ? 1 : p.life / 14; const riseY = p.y - progress * 46;
        ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, riseY); ctx.rotate(-0.05);
        if (plusIcon.complete && plusIcon.naturalWidth > 0) { const h = 26; const w = h * (plusIcon.naturalWidth / plusIcon.naturalHeight); ctx.drawImage(plusIcon, -w - 4, -34, w, h); }
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';

        // Combo and Critical are premium events and use the same large size
        if (p.type === 'combo' || p.type === 'critical') {
            ctx.font = "bold 48px 'Gang of Three', sans-serif";
            ctx.lineWidth = 7;
            ctx.strokeStyle = '#5b3a1c';
            ctx.fillStyle = '#FFD478';
            ctx.strokeText(p.text, 0, 0);
            ctx.fillText(p.text, 0, 0);

            if (p.bonus) {
                ctx.font = "bold 32px 'Gang of Three', sans-serif";
                ctx.fillText('+' + p.bonus, 10, 38);
            }
        } else {
            ctx.font = "bold 28px 'Gang of Three', sans-serif";
            ctx.lineWidth = 5;
            ctx.strokeStyle = '#16234a';
            ctx.fillStyle = '#5B9CEF';
            ctx.strokeText(p.text, 0, 0);
            ctx.fillText(p.text, 0, 0);

            if (p.bonus) {
                ctx.font = "bold 22px 'Gang of Three', sans-serif";
                ctx.strokeText('+' + p.bonus, 8, 27);
                ctx.fillStyle = '#8fc1ff';
                ctx.fillText('+' + p.bonus, 8, 27);
            }
        }
        ctx.restore(); p.life--; return p.life > 0;
    });
}
function drawSplashes() {
    const size = 110;
    splashes = splashes.filter(s => {
        ctx.save(); ctx.globalAlpha = Math.min(1, (s.life / s.maxLife) * 2);
        ctx.translate(s.x, s.y);
        if (s.angle) ctx.rotate(s.angle);
        ctx.drawImage(s.img, -size / 2, -size / 2, size, size);
        ctx.restore(); s.life--; return s.life > 0;
    });
}
function drawSliceTrail() {
    if (sliceTrail.length === 0) return;
    if (sliceTrail.length > 1) {
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.shadowColor = 'rgba(255,210,90,.9)'; ctx.shadowBlur = 18; ctx.lineWidth = 6; ctx.beginPath();
        ctx.moveTo(sliceTrail[0].x, sliceTrail[0].y);
        for (let i = 1; i < sliceTrail.length; i++) ctx.lineTo(sliceTrail[i].x, sliceTrail[i].y);
        ctx.stroke(); ctx.restore();
    }
    sliceTrail.forEach(p => { ctx.save(); ctx.globalAlpha = p.life / 16; if (cutImg.complete && cutImg.naturalWidth > 0) ctx.drawImage(cutImg, p.x - 35, p.y - 35, 70, 70); ctx.restore(); p.life--; });
    sliceTrail = sliceTrail.filter(p => p.life > 0);
}
function drawImageFixedHeight(image, x, y, height, rotation) {
    if (!image.complete || image.naturalWidth === 0) return;
    const width = height * (image.naturalWidth / image.naturalHeight);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.drawImage(image, -width / 2, -height / 2, width, height); ctx.restore();
}

// SCREEN SHAKE ON KABOOM
function showKaboom(ending) {
    if (ending) { updateLives(3); hud.classList.add('faded'); }

    const container = document.getElementById('gameContainer');
    container.classList.remove('shake-effect');
    void container.offsetWidth;
    container.classList.add('shake-effect');

    kaboomEffect.classList.remove('show'); void kaboomEffect.offsetWidth; kaboomEffect.classList.add('show');
    setTimeout(() => kaboomEffect.classList.remove('show'), 950);
}

function gameOver() {
    if (!gameRunning) return;
    playGameOverSound(); gameRunning = false; paused = false; stopGameTimers();
    if (score > bestScore) { bestScore = score; localStorage.setItem('fn_best_score', bestScore); document.getElementById('bestScore').textContent = bestScore; }
    document.getElementById('finalScore').textContent = score; ctx.clearRect(0, 0, gameWidth(), gameHeight());
    updateLives(3); goToScreen(6);
    gameOverTimer = setTimeout(() => { if (currentScreen === 6) showScoreScreen(); }, 2200);
}
function showScoreScreen() { document.getElementById('finalScore').textContent = score; goToScreen(7); }
function quitGame() { restartGame(); goToScreen(1); }
function restartGame() {
    stopGameTimers(); score = 0; lives = 3; paused = false; selectedDifficulty = null;
    fruits = []; halves = []; splashes = []; sliceTrail = []; popups = []; comboCount = 0; clearTimeout(comboTimer);
    lastAudioSlicePoint = null; ctx.clearRect(0, 0, gameWidth(), gameHeight());
    document.getElementById('scoreValue').textContent = '0'; updateLives(); goToScreen(2);
}
function stopGameTimers() {
    if (gameOverTimer) { clearTimeout(gameOverTimer); gameOverTimer = null; }
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    if (gameAnimationId) { cancelAnimationFrame(gameAnimationId); gameAnimationId = null; }
}

/* ========================================================= KINECT 360 =========================================================
   The browser can't read a Kinect directly. KinectBridge (a small Windows program using the Kinect SDK v1.8)
   streams hand positions over a WebSocket. Each message looks like:
     { "tracked": true, "x": 0..1, "y": 0..1, "pause": false }
   x/y are already normalised to the "reach box" in front of the player (0,0 = top-left of the screen).
   Menus: hover your hand over a button for ~1.2s to click it.  Pause: raise BOTH hands above your head.
================================================================================================================================ */
const KINECT_URL = 'ws://localhost:8181';
const KINECT_FLIP_X = false;      // set true if your hand moves the opposite way on screen
const KINECT_SMOOTHING = 0.5;
const DWELL_MS = 1200;

const kinectCursor = document.getElementById('kinectCursor');
let kinectSocket = null, lastKinectAt = 0, kinectSmoothed = null, kinectConnected = false;
let lastKinectPause = 0, dwellTarget = null, dwellStart = 0, dwellCooldownUntil = 0;

function kinectActive() { return Date.now() - lastKinectAt < 1000; }

function connectKinect() {
    try { kinectSocket = new WebSocket(KINECT_URL); } catch (e) { setTimeout(connectKinect, 3000); return; }
    kinectSocket.onopen = () => { kinectConnected = true; console.log('Kinect bridge connected'); };
    kinectSocket.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (err) { return; } onKinectData(d); };
    kinectSocket.onclose = () => { kinectConnected = false; hideKinectCursor(); setTimeout(connectKinect, 3000); };
    kinectSocket.onerror = () => { try { kinectSocket.close(); } catch (err) {} };
}

function hideKinectCursor() { kinectCursor.classList.remove('show'); kinectSmoothed = null; dwellTarget = null; }

function onKinectData(d) {
    if (!d.tracked) {
        hideKinectCursor(); lastAudioSlicePoint = null;
        if (!kinectActive()) setHandStatus('Kinect connected — step back so it can see you', 'warning');
        return;
    }
    lastKinectAt = Date.now(); setHandStatus('Kinect tracking ✓', 'tracking');

    const raw = { x: (KINECT_FLIP_X ? 1 - d.x : d.x) * gameWidth(), y: d.y * gameHeight() };
    if (!kinectSmoothed) kinectSmoothed = { x: raw.x, y: raw.y };
    else { kinectSmoothed.x += (raw.x - kinectSmoothed.x) * KINECT_SMOOTHING; kinectSmoothed.y += (raw.y - kinectSmoothed.y) * KINECT_SMOOTHING; }
    const { x, y } = kinectSmoothed;

    kinectCursor.style.left = x + 'px'; kinectCursor.style.top = y + 'px';
    kinectCursor.classList.add('show');
    kinectCursor.classList.toggle('in-game', gameRunning && !paused);

    if (gameRunning && !paused) addSlicePoint(x, y);
    updateDwell(x, y);

    // Both hands above head = pause / resume
    if (d.pause && gameRunning && Date.now() - lastKinectPause > 1500) { lastKinectPause = Date.now(); togglePause(); }
}

function updateDwell(x, y) {
    const canDwell = !gameRunning || paused;
    const now = Date.now();
    let target = null;
    if (canDwell && now > dwellCooldownUntil) {
        const el = document.elementFromPoint(x, y);
        target = el && el.closest('button, .ring-btn, .s2-back, .control-btn');
    }
    if (target !== dwellTarget) { dwellTarget = target; dwellStart = now; }
    const progress = target ? Math.min(100, ((now - dwellStart) / DWELL_MS) * 100) : 0;
    kinectCursor.style.setProperty('--p', progress);
    if (target && progress >= 100) {
        playButtonSound(); target.click();
        dwellTarget = null; dwellCooldownUntil = now + 1000; kinectCursor.style.setProperty('--p', 0);
    }
}

connectKinect();