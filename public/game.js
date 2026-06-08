// Firebase is loaded via CDN compat scripts in index.html

const appId = typeof __app_id !== 'undefined' ? __app_id : 'corginitecrisis';

// Use injected config (AI Studio) or fall back to production config
let firebaseConfig = {};
if (typeof __firebase_config !== 'undefined') {
    try { firebaseConfig = JSON.parse(__firebase_config); } catch(e) {}
}
// If no injected config, use the hardcoded production config.
// TO SET UP: Go to Firebase Console → Project Settings → Your Apps → SDK setup → Config
// and paste the values below.
if (!firebaseConfig.apiKey) {
    firebaseConfig = {
        apiKey: "AIzaSyAOqB43_yhJpGV05MByUxrDj1GZEIYMyUk",
        authDomain: "corginitecrisis.firebaseapp.com",
        projectId: "corginitecrisis",
        storageBucket: "corginitecrisis.firebasestorage.app",
        messagingSenderId: "1037190707756",
        appId: "1:1037190707756:web:b872118364ea07f8c22f89"
    };
}

let auth = null, db = null, provider = null;

try {
    const app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth(app);
    db = firebase.firestore(app);
    provider = new firebase.auth.GoogleAuthProvider();
} catch(e) {
    console.warn("Firebase init failed (no config provided):", e.message);
}

let currentUser = null;
let isDevUser = false;
const DEV_EMAIL = 'jeremygobrecht@gmail.com';
let maxLevelBeaten = 0;
let currentLevel = 1;
const TOTAL_LEVELS = 5;
let levelCompleteTriggered = false;
const levelGoals = { 1: 10, 2: 15, 3: 20, 4: 25, 5: 35 };

function updateDevButtonVisibility() {
    const devBtn = document.getElementById('dev-start-btn');
    if (devBtn) devBtn.style.display = isDevUser ? 'block' : 'none';
}

if (auth) {
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            // No signed-in user — sign in anonymously (or with custom token).
            // Doing this here (instead of at startup) avoids racing with persisted Google sessions.
            try {
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await auth.signInWithCustomToken(__initial_auth_token);
                } else {
                    await auth.signInAnonymously();
                }
            } catch(e) { console.warn("Auth initialization issue:", e); }
            return; // onAuthStateChanged will fire again with the new user
        }

        currentUser = user;
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) {
            isDevUser = !user.isAnonymous && user.email === DEV_EMAIL;
            if (user.isAnonymous) {
                loginBtn.innerText = "CONNECT GOOGLE";
                loginBtn.style.background = '#E4A082';
                loginBtn.style.color = '#BA5851';
            } else {
                loginBtn.innerText = "LOGOUT GOOGLE";
                loginBtn.style.background = '#ACBA8A';
                loginBtn.style.color = '#8D4645';
            }
        }
        // Update DEV button immediately — don't wait for the Firestore fetch below
        updateDevButtonVisibility();
        try {
            if (db) {
                const docRef = db.collection('artifacts').doc(appId)
                    .collection('users').doc(user.uid)
                    .collection('gameData').doc('progress');
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    maxLevelBeaten = docSnap.data().maxLevelBeaten || 0;
                } else {
                    maxLevelBeaten = 0;
                }
                updateLevelSelectUI();
            }
        } catch(e) { console.warn("Fetch progress issue:", e); }
    });
}

async function saveProgress(levelBeat) {
    if (!currentUser || !db) return;
    maxLevelBeaten = Math.max(maxLevelBeaten, levelBeat);
    updateLevelSelectUI();
    try {
        const docRef = db.collection('artifacts').doc(appId)
            .collection('users').doc(currentUser.uid)
            .collection('gameData').doc('progress');
        await docRef.set({ maxLevelBeaten: maxLevelBeaten }, { merge: true });
    } catch(e) { console.warn("Save progress issue:", e); }
}

function updateLevelSelectUI() {
    const grid = document.getElementById('level-grid');
    grid.innerHTML = '';
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
        const btn = document.createElement('button');
        btn.className = 'ui-box menu-btn';
        if (i <= maxLevelBeaten + 1) {
            btn.innerText = `LEVEL ${i}`;
            btn.onclick = () => startGame('NORMAL', null, [], i);
        } else {
            btn.innerText = `LOCKED`;
            btn.style.opacity = '0.5';
            btn.style.pointerEvents = 'none';
        }
        grid.appendChild(btn);
    }
}

// --- GAME ENGINE ---
let lastTime = 0;
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const wrapper = document.getElementById('game-wrapper');
const apngContainer = document.getElementById('apng-container');
const corgiContainer = document.getElementById('corgi-container');
const corgiJumpOverlay = document.getElementById('corgi-jump-overlay');
const corgiWalkOverlay = document.getElementById('corgi-walk-overlay');
const corgiStandOverlay = document.getElementById('corgi-stand-overlay');
const corgiDiveOverlay = document.getElementById('corgi-dive-overlay');

const startMenu = document.getElementById('start-menu');
const levelMenu = document.getElementById('level-menu');
const scoreMenu = document.getElementById('score-menu');
const pauseMenu = document.getElementById('pause-menu');
const controlsMenu = document.getElementById('controls-menu');
const objectiveMenu = document.getElementById('objective-menu');
const devMenu = document.getElementById('dev-menu');
const tutorialMenu = document.getElementById('tutorial-menu');
const codecMenu = document.getElementById('codec-menu');
const hudScore = document.getElementById('hud-score');
const hudLevelInd = document.getElementById('hud-level-indicator');
const tutorialProgressHUD = document.getElementById('tutorial-progress');
const hudHealth = document.getElementById('hud-health');
const hudCountdown = document.getElementById('hud-countdown');
const hudGameover = document.getElementById('hud-gameover');
const tutorialMsgBox = document.getElementById('tutorial-msg-box');
const bgm = document.getElementById('bgm');
bgm.volume = 0.15;

// Game dimensions — internal resolution
const GAME_W = 1600;
const GAME_H = 900;
let SCREEN_WIDTH = GAME_W;
const SCREEN_HEIGHT = GAME_H;

let scaleX = 1;
let scaleY = 1;

let CORGI_SCALE = 1.2;
let BIKE_SCALE = 1.2;
let MAILMAN1_SCALE = 1.2;
let MAILMAN2_SCALE = 1.2;
let BASE_DRONE_WIDTH = 213;
let ITEM_SCALE = 1.0;
window.isPortraitDevice = false;

let dt = 1;
let gameState = 'MENU';
let playMode = 'NORMAL';
let cameraZoom = 1.0;
let countdownTimer = 0;

const MAX_HEALTH = 3;
let currentHealth = MAX_HEALTH;
let invulnTimer = 0;
let previousMenuState = 'MENU';
let currentDevEnemy = null;

let tutorialQueue = [];
let currentTutType = null;
let tutPhase = 0;
let tutProgress = 0;
let tutGoal = 0;
let isAllTutorials = false;
const keys = { left: false, right: false, down: false, shift: false };

function resize() {
    const isPortrait = window.innerHeight > window.innerWidth;
    window.isPortraitDevice = isPortrait;

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    if (isPortrait) {
        SCREEN_WIDTH = GAME_W * (screenW / screenH);
        scaleX = screenH / GAME_W;
        scaleY = screenW / GAME_H;
    } else {
        SCREEN_WIDTH = GAME_W * (screenW / screenH);
        scaleX = screenW / SCREEN_WIDTH;
        scaleY = screenH / GAME_H;
    }

    canvas.width = SCREEN_WIDTH;
    canvas.height = GAME_H;
    canvas.style.width = screenW + 'px';
    canvas.style.height = screenH + 'px';

    const overlayScaleX = screenW / SCREEN_WIDTH;
    const overlayScaleY = screenH / GAME_H;

    apngContainer.style.transformOrigin = '0 0';
    apngContainer.style.transform = `scale(${overlayScaleX}, ${overlayScaleY})`;
    apngContainer.style.width = SCREEN_WIDTH + 'px';
    apngContainer.style.height = GAME_H + 'px';

    corgiContainer.style.transformOrigin = '0 0';
    corgiContainer.style.transform = `scale(${overlayScaleX}, ${overlayScaleY})`;
    corgiContainer.style.width = SCREEN_WIDTH + 'px';
    corgiContainer.style.height = GAME_H + 'px';

    let mScale = isPortrait ? 1.35 : 1.0;
    CORGI_SCALE = 1.2 * mScale;
    BIKE_SCALE = 1.2 * mScale;
    MAILMAN1_SCALE = 1.2 * mScale;
    MAILMAN2_SCALE = 1.2 * mScale;
    BASE_DRONE_WIDTH = 213 * mScale;
    ITEM_SCALE = mScale;

    if (corg) {
        corg.w = 121 * CORGI_SCALE;
        corg.h = 86 * CORGI_SCALE;
    }

    if (isPortrait) {
        wrapper.style.transform = `rotate(90deg)`;
        wrapper.style.width = screenH + 'px';
        wrapper.style.height = screenW + 'px';
        wrapper.style.top = ((screenH - screenW) / 2) + 'px';
        wrapper.style.left = -((screenH - screenW) / 2) + 'px';
    } else {
        wrapper.style.transform = '';
        wrapper.style.width = '100vw';
        wrapper.style.height = '100vh';
        wrapper.style.top = '0';
        wrapper.style.left = '0';
    }
}

window.addEventListener('resize', resize);

const GRAVITY = 0.4;
const FLAP_STRENGTH = -10;
const BASE_OBSTACLE_SPEED = 6.0;
const BASE_OBSTACLE_FREQUENCY = 1200;
const BACKGROUND_SCROLL_SPEED = 2.8;
let currentObsSpeed = BASE_OBSTACLE_SPEED;
let currentObsFreq = BASE_OBSTACLE_FREQUENCY;

const images = {};
const loadImg = (name, src) => {
    const img = new Image(); img.src = src; images[name] = img; return img;
};
loadImg('corgi', 'assets/corgi.png');
loadImg('corgiStand', 'assets/corgiStand.PNG');
loadImg('corgiDive', 'assets/corgiDive.PNG');
loadImg('mail', 'assets/mail.png');
loadImg('bg2', 'assets/background2.png');
// Building APNGs: reference the live DOM <img> elements so the browser animates each frame
images['building1a'] = document.getElementById('anim-b1a');
images['building1b'] = document.getElementById('anim-b1b');
images['building1c'] = document.getElementById('anim-b1c');
const bikeImg = loadImg('bike', 'assets/bike1.png');
const droneVariants = [
    loadImg('drone1a', 'assets/drone1a.png'),
    loadImg('drone1b', 'assets/drone1b.png'),
    loadImg('drone1c', 'assets/drone1c.png'),
    loadImg('drone1d', 'assets/drone1d.png'),
    loadImg('drone1e', 'assets/drone1e.png'),
    loadImg('drone3', 'assets/drone3.png'),
    loadImg('drone4', 'assets/drone4.png')
];
const mailmanVariants = [
    loadImg('mailman1', 'assets/mailman1.png'),
    loadImg('mailman2', 'assets/mailman2.png')
];

function colliderect(r1, r2) {
    return r1.x < r2.x + r2.w && r1.x + r1.w > r2.x && r1.y < r2.y + r2.h && r1.y + r1.h > r2.y;
}

function updateHealthHUD() {
    hudHealth.innerHTML = '';
    for (let i = 0; i < MAX_HEALTH; i++) {
        const fill = i < currentHealth ? '#DA6A5C' : '#924A48';
        hudHealth.innerHTML += `<svg width="45" height="45" viewBox="0 0 24 24" fill="${fill}" stroke="#8D4645" stroke-width="2" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
    }
}

class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y;
        this.vx = (Math.random() - 0.5) * 10;
        this.vy = (Math.random() - 0.5) * 10;
        this.life = 1.0;
        this.decay = 0.02 + Math.random() * 0.03;
        this.color = color;
        this.size = (15 + Math.random() * 20) * ITEM_SCALE;
    }
    update() {
        this.x += this.vx * dt; this.y += this.vy * dt; this.life -= this.decay * dt;
    }
    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

let particles = [];
function spawnParticles(x, y, colors, count) {
    for (let i = 0; i < count; i++) {
        let color = Array.isArray(colors) ? colors[Math.floor(Math.random() * colors.length)] : colors;
        particles.push(new Particle(x, y, color));
    }
}

class ParallaxBackground {
    constructor() {
        this.layers = [
            { id: 'street',     speed: 1.0,  scroll: 0 },
            { id: 'building1c', speed: 0.12, scroll: 0, heightMod: 1.0 },  // furthest back, slowest
            { id: 'building1b', speed: 0.22, scroll: 0, heightMod: 1.0 },  // mid layer
            { id: 'building1a', speed: 0.38, scroll: 0, heightMod: 1.0 },  // closest building, fastest
            { id: 'bg2',        speed: 0.5,  scroll: 0, heightMod: 0.60 }  // foreground detail layer
        ];
    }
    update() {
        const baseSpeed = BACKGROUND_SCROLL_SPEED * dt;
        this.layers.forEach(layer => {
            if (layer.id === 'street') {
                layer.scroll -= baseSpeed * layer.speed;
                if (Math.abs(layer.scroll) >= 200) layer.scroll = 0;
            } else if (layer.id.startsWith('building')) {
                // Buildings scroll; wrap based on 1.5x natural width to match draw size
                const img = images[layer.id];
                if (img && img.complete && img.naturalWidth > 0) {
                    layer.scroll -= baseSpeed * layer.speed;
                    if (Math.abs(layer.scroll) >= img.naturalWidth * 2.5) layer.scroll = 0;
                }
            } else {
                const img = images[layer.id];
                if (img && img.complete && img.naturalWidth > 0) {
                    const drawH = SCREEN_HEIGHT * layer.heightMod;
                    const imgWidth = img.naturalWidth * (drawH / img.naturalHeight);
                    layer.scroll -= baseSpeed * layer.speed;
                    if (Math.abs(layer.scroll) >= imgWidth) layer.scroll = 0;
                }
            }
        });
    }
    draw() {
        const groundY = SCREEN_HEIGHT - (SCREEN_HEIGHT / 3); // top of the street band
        this.layers.forEach(layer => {
            if (layer.id === 'street') {
                ctx.fillStyle = '#CF9579'; ctx.fillRect(0, groundY, SCREEN_WIDTH, SCREEN_HEIGHT / 3);
                ctx.strokeStyle = '#A86259'; ctx.lineWidth = 10;
                ctx.beginPath(); ctx.moveTo(0, groundY + 5); ctx.lineTo(SCREEN_WIDTH, groundY + 5); ctx.stroke();
                ctx.strokeStyle = '#E4A082'; ctx.lineWidth = 6;
                for (let x = layer.scroll; x < SCREEN_WIDTH + 200; x += 200) {
                    ctx.beginPath(); ctx.moveTo(x, groundY + 35); ctx.lineTo(x + 100, groundY + 35); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(x + 200, groundY + 85); ctx.lineTo(x + 300, groundY + 85); ctx.stroke();
                }
            } else if (layer.id.startsWith('building')) {
                // Draw at 1.5x natural size (uniform scale, no stretch), anchored to ground
                const img = images[layer.id];
                if (img && img.complete && img.naturalWidth > 0) {
                    const imgWidth = img.naturalWidth * 2.5;
                    const imgHeight = img.naturalHeight * 2.5;
                    const yPos = groundY - imgHeight + SCREEN_HEIGHT * 0.12; // shift down so tops sit lower
                    const numTiles = Math.ceil(SCREEN_WIDTH / imgWidth) + 2;
                    for (let i = 0; i < numTiles; i++) {
                        ctx.drawImage(img, i * imgWidth + layer.scroll, yPos, imgWidth, imgHeight);
                    }
                }
            } else {
                const img = images[layer.id];
                if (img && img.complete && img.naturalWidth > 0) {
                    const drawH = SCREEN_HEIGHT * layer.heightMod;
                    const imgWidth = img.naturalWidth * (drawH / img.naturalHeight);
                    const numTiles = Math.ceil(SCREEN_WIDTH / imgWidth) + 1;
                    let yPos = (layer.id === 'bg2') ? SCREEN_HEIGHT * 0.05 : 0;
                    for (let i = 0; i < numTiles; i++) {
                        ctx.drawImage(img, i * imgWidth + layer.scroll, yPos, imgWidth, drawH);
                    }
                }
            }
        });
    }
}

class Corg {
    constructor() {
        this.w = 121 * CORGI_SCALE;
        this.h = 86 * CORGI_SCALE;
        this.x = -200;
        this.y = SCREEN_HEIGHT - this.h - 30;
        this.velocity = 0;
        this.isDrawingStatic = true;
        this.ridingDrone = null;
        this.isDashing = false;
        this.dashTimer = 0;
        this.dashCooldown = 0;
        this.dashSpeed = 0;
        this.afterImages = [];
    }
    flap() {
        if (this.isDashing || gameState === 'WALK_IN' || gameState === 'CUTSCENE') return;
        this.ridingDrone = null;
        this.velocity = FLAP_STRENGTH;
    }
    update(frameTime) {
        if (invulnTimer > 0) invulnTimer -= frameTime;
        if (keys.shift && this.dashCooldown <= 0 && !this.isDashing && gameState === 'PLAY') {
            this.isDashing = true;
            this.dashTimer = 250;
            this.dashCooldown = 1500;
            this.dashSpeed = (this.w * 3) / (250 / 16.67);
            this.ridingDrone = null;
        }
        if (this.isDashing) {
            this.x += this.dashSpeed * dt;
            this.dashTimer -= frameTime;
            this.velocity = 0;
            if (this.dashTimer % 40 < 20) this.afterImages.push({ x: this.x, y: this.y, life: 0.8 });
            if (this.dashTimer <= 0 || this.x >= SCREEN_WIDTH - this.w) this.isDashing = false;
        } else if (this.ridingDrone) {
            if (this.dashCooldown > 0) this.dashCooldown -= frameTime;
            const d = this.ridingDrone;
            const speed = d.speedMult === 0 ? currentObsSpeed * dt : currentObsSpeed * d.speedMult * dt;
            if (keys.down && !d.isFalling && gameState === 'PLAY') {
                d.isGuidedDescending = true;
                d.guideDir = 0;
                if (keys.left) d.guideDir = -1;
                if (keys.right) d.guideDir = 1;
            } else {
                d.isGuidedDescending = false;
                d.guidedTimer = 0;
            }
            let dSpeedX = 0;
            if (d.isGuidedDescending) {
                if (d.guideDir === -1) dSpeedX = -6 * dt;
                else if (d.guideDir === 1) dSpeedX = 6 * dt;
                else dSpeedX = d.movingRight ? speed * 0.5 : -(speed * 0.5);
            } else {
                dSpeedX = d.movingRight ? speed : -speed;
            }
            if (d.speedMult === 0 && !d.isGuidedDescending) dSpeedX = 0;
            this.x += dSpeedX;
            if (gameState === 'PLAY') {
                if (keys.left) this.x -= 7.2 * dt;
                if (keys.right) this.x += 7.2 * dt;
            }
            const cCenterX = this.x + this.w / 2;
            if (cCenterX < d.x || cCenterX > d.x + d.w || d.isFalling) {
                this.ridingDrone = null;
                if (d.isGuidedDescending) { d.isGuidedDescending = false; d.guidedTimer = 0; }
            } else {
                const dRect = d.getRect();
                let verticalOffset = 0.15 * d.h;
                if (d.droneIndex === 5) verticalOffset = 0.05 * d.h;
                if (d.droneIndex === 6) verticalOffset = 0.22 * d.h;
                this.y = dRect.y + verticalOffset - this.h - 10;
                this.velocity = 0;
            }
        } else {
            if (this.dashCooldown > 0) this.dashCooldown -= frameTime;
            this.velocity += GRAVITY * dt;
            this.y += this.velocity * dt;
        }
        this.afterImages.forEach(ai => ai.life -= 0.05 * dt);
        this.afterImages = this.afterImages.filter(ai => ai.life > 0);
        const bottomLimit = SCREEN_HEIGHT - this.h - 30;
        this.y = Math.max(0, Math.min(bottomLimit, this.y));
        const isGrounded = this.y >= bottomLimit - 1;
        if (gameState === 'PLAY' && !this.isDashing && !this.ridingDrone) {
            const moveSpeed = 7.2 * dt;
            const driftSpeed = BACKGROUND_SCROLL_SPEED * 0.2 * dt;
            if (keys.left) this.x -= moveSpeed;
            else if (keys.right) this.x += moveSpeed;
            else if (playMode === 'NORMAL' || playMode === 'DEV') this.x -= driftSpeed;
            if (keys.down) this.velocity += GRAVITY * 4 * dt;
            this.x = Math.max(0, Math.min(SCREEN_WIDTH - this.w, this.x));
        } else if (gameState === 'PLAY' && !this.isDashing) {
            this.x = Math.max(0, Math.min(SCREEN_WIDTH - this.w, this.x));
        }
        let isMoving = keys.left || keys.right || gameState === 'WALK_IN' || (gameState === 'COUNTDOWN' && this.x < 100);
        let isJumpingUp = this.velocity < 0 && !this.ridingDrone && !this.isDashing;
        let isDiving = keys.down && this.velocity > 0 && !isGrounded && !this.ridingDrone && !this.isDashing && gameState !== 'WALK_IN';

        corgiJumpOverlay.style.display = 'none';
        corgiWalkOverlay.style.display = 'none';
        corgiStandOverlay.style.display = 'none';
        corgiDiveOverlay.style.display = 'none';

        if (gameState === 'CUTSCENE') { this.isDrawingStatic = true; return; }

        if (isDiving) {
            corgiDiveOverlay.style.display = 'block';
            corgiDiveOverlay.style.transform = `translate(${this.x}px, ${this.y}px)`;
            corgiDiveOverlay.style.width = this.w + 'px';
            corgiDiveOverlay.style.height = this.h + 'px';
            this.isDrawingStatic = false;
        } else if (isJumpingUp) {
            corgiJumpOverlay.style.display = 'block';
            corgiJumpOverlay.style.transform = `translate(${this.x}px, ${this.y}px)`;
            corgiJumpOverlay.style.width = this.w + 'px';
            corgiJumpOverlay.style.height = this.h + 'px';
            this.isDrawingStatic = false;
        } else if ((isGrounded || this.ridingDrone) && !this.isDashing && (gameState === 'PLAY' || gameState === 'COUNTDOWN' || gameState === 'WALK_IN')) {
            if (this.ridingDrone && !isMoving) {
                corgiStandOverlay.style.display = 'block';
                corgiStandOverlay.style.transform = `translate(${this.x}px, ${this.y}px)`;
                corgiStandOverlay.style.width = this.w + 'px';
                corgiStandOverlay.style.height = this.h + 'px';
            } else {
                corgiWalkOverlay.style.display = 'block';
                corgiWalkOverlay.style.transform = `translate(${this.x}px, ${this.y}px)`;
                corgiWalkOverlay.style.width = this.w + 'px';
                corgiWalkOverlay.style.height = this.h + 'px';
            }
            this.isDrawingStatic = false;
        } else {
            this.isDrawingStatic = true;
        }
        const tintFilter = invulnTimer > 0 ? 'sepia(1) hue-rotate(320deg) brightness(0.6) saturate(1.5)' : 'none';
        corgiJumpOverlay.style.filter = tintFilter;
        corgiWalkOverlay.style.filter = tintFilter;
        corgiStandOverlay.style.filter = tintFilter;
        corgiDiveOverlay.style.filter = tintFilter;
    }
    draw() {
        this.afterImages.forEach(ai => {
            ctx.save();
            ctx.globalAlpha = ai.life * 0.5;
            if (invulnTimer > 0) ctx.filter = 'sepia(1) hue-rotate(320deg) brightness(0.6) saturate(1.5)';
            const img = images['corgi'];
            if (img && img.complete) ctx.drawImage(img, ai.x, ai.y, this.w, this.h);
            ctx.restore();
        });
        if (this.isDrawingStatic) {
            const img = images['corgi'];
            if (img && img.complete && img.naturalWidth > 0) {
                ctx.save();
                if (invulnTimer > 0) ctx.filter = 'sepia(1) hue-rotate(320deg) brightness(0.6) saturate(1.5)';
                ctx.drawImage(img, this.x, this.y, this.w, this.h);
                ctx.restore();
            }
        }
    }
    getRect() { return { x: this.x + this.w * 0.15, y: this.y + this.h * 0.2, w: this.w * 0.7, h: this.h * 0.65 }; }
}

class Obstacle {
    constructor(type, lane, isBigDrone, spawnLeft, specificType, stationary) {
        lane = lane || 0;
        isBigDrone = isBigDrone || false;
        spawnLeft = spawnLeft || false;
        specificType = specificType || null;
        stationary = stationary || false;

        const jitter = stationary ? 0 : (Math.random() - 0.5) * 80;
        this.type = type;
        const laneHeight = (SCREEN_HEIGHT * (2 / 3)) / 3;
        this.wobbleTimer = Math.random() * Math.PI * 2;
        this.wobbleSpeed = 0.04 + Math.random() * 0.04;
        this.wobbleAmp = stationary ? 4 : (8 + Math.random() * 8);
        this.currentWobble = 0;
        this.isFalling = false;
        this.fallVy = 0;
        this.rotation = 0;
        this.rotationSpeed = 0;
        this.markedForDeletion = false;
        this.isGuidedDescending = false;
        this.guidedTimer = 0;
        this.guideDir = 0;
        this.speedMult = stationary ? 0 : 1.0;
        this.fallReason = null;
        this.counted = false;
        if (specificType) {
            if (specificType.startsWith('drone')) {
                this.type = 'drone';
                if (specificType === 'drone1a') { this.droneIndex = 0; this.img = droneVariants[0]; }
                if (specificType === 'drone1b') { this.droneIndex = 1; this.img = droneVariants[1]; }
                if (specificType === 'drone1c') { this.droneIndex = 2; this.img = droneVariants[2]; }
                if (specificType === 'drone1d') { this.droneIndex = 3; this.img = droneVariants[3]; }
                if (specificType === 'drone1e') { this.droneIndex = 4; this.img = droneVariants[4]; }
                if (specificType === 'drone3') { this.droneIndex = 5; this.img = droneVariants[5]; }
                if (specificType === 'drone4') { this.droneIndex = 6; this.img = droneVariants[6]; isBigDrone = true; }
                if (!stationary) this.speedMult = this.droneIndex === 6 ? 1.25 : 1.0;
            } else if (specificType.startsWith('mailman')) {
                this.type = 'mailman';
                if (specificType === 'mailman1') this.img = mailmanVariants[0];
                if (specificType === 'mailman2') this.img = mailmanVariants[1];
                if (!stationary) this.speedMult = 0.75;
            } else if (specificType === 'bike1') {
                this.type = 'bike';
                this.img = bikeImg;
                if (!stationary) this.speedMult = 2.5;
            }
        }
        if (this.type === 'bike') {
            if (!this.img) this.img = bikeImg;
            if (!stationary) this.speedMult = 2.5;
            this.w = 104 * BIKE_SCALE; this.h = 156 * BIKE_SCALE;
            this.y = SCREEN_HEIGHT - (this.h + 10);
            this.x = SCREEN_WIDTH + jitter;
            this.movingRight = false;
        } else if (this.type === 'mailman') {
            if (!this.img) {
                const idx = Math.floor(Math.random() * mailmanVariants.length);
                this.img = mailmanVariants[idx];
            }
            if (!stationary) this.speedMult = 0.75;
            const specificScale = this.img === mailmanVariants[0] ? MAILMAN1_SCALE : MAILMAN2_SCALE;
            this.w = 104 * specificScale; this.h = 156 * specificScale;
            this.y = SCREEN_HEIGHT - (this.h + 10);
            this.x = SCREEN_WIDTH + jitter;
            this.movingRight = false;
        } else {
            this.w = BASE_DRONE_WIDTH;
            if (isBigDrone) {
                if (!this.img) { this.droneIndex = 6; this.img = droneVariants[6]; }
                if (!stationary) this.speedMult = 1.25;
                this.isScriptedDescending = false;
                if (spawnLeft) {
                    this.x = stationary ? 200 : (-this.w - Math.random() * 100);
                    this.movingRight = true;
                    this.descendTriggerX = SCREEN_WIDTH / 2 + Math.random() * (SCREEN_WIDTH / 2);
                } else {
                    this.x = stationary ? SCREEN_WIDTH / 2 - this.w / 2 : SCREEN_WIDTH + jitter;
                    this.movingRight = false;
                    this.descendTriggerX = Math.random() * (SCREEN_WIDTH / 2);
                }
            } else {
                if (!this.img) {
                    if (Math.random() < 0.25) this.droneIndex = 5;
                    else this.droneIndex = Math.floor(Math.random() * 5);
                    this.img = droneVariants[this.droneIndex];
                }
                this.x = stationary ? SCREEN_WIDTH / 2 - this.w / 2 : SCREEN_WIDTH + jitter;
                this.movingRight = false;
            }
            let aspectRatio = (this.img && this.img.complete && this.img.naturalWidth > 0)
                ? this.img.naturalHeight / this.img.naturalWidth
                : (this.droneIndex === 6 ? 1.14 : 0.65);
            this.h = this.w * aspectRatio;
            this.y = isBigDrone
                ? (lane + 1) * laneHeight - this.h / 2
                : lane * laneHeight + laneHeight / 2 - this.h / 2;
        }
        if (this.type === 'drone' || this.type === 'bike') {
            this.domImg = document.createElement('img');
            this.domImg.src = this.img ? this.img.src : '';
            this.domImg.className = 'apng-sprite';
            this.domImg.style.width = this.w + 'px';
            this.domImg.style.height = this.h + 'px';
            apngContainer.appendChild(this.domImg);
        }
    }

    update(obsArray, frameTime) {
        let speed = currentObsSpeed * this.speedMult;
        if (this.isGuidedDescending && !this.isFalling) {
            this.guidedTimer = (this.guidedTimer || 0) + (frameTime || 16.67);
            this.y += 2.5 * dt;
            if (this.guideDir === -1) this.x -= 6 * dt;
            else if (this.guideDir === 1) this.x += 6 * dt;
            else {
                if (this.movingRight) this.x += speed * 0.5 * dt;
                else this.x -= speed * 0.5 * dt;
            }
            if (this.guidedTimer > 600) {
                this.isGuidedDescending = false;
                this.isFalling = true;
                this.fallReason = 'guided';
                let timeToFall = (SCREEN_WIDTH / 4) / currentObsSpeed;
                this.fallVy = (SCREEN_HEIGHT - this.y) / timeToFall;
                this.rotationSpeed = 0.05;
                spawnParticles(this.x + this.w / 2, this.y, ['#8D4645', '#BA5851', '#C97062'], 30);
                invulnTimer = 500;
                corg.velocity = FLAP_STRENGTH * 0.7;
            }
        } else if (!this.isFalling) {
            if (this.movingRight) {
                if (gameState === 'MENU' || gameState === 'SCORE_MENU' || gameState === 'WALK_IN') this.x += speed * 0.4 * dt;
                else if (gameState === 'ZOOM_OUT') this.x += speed * 3 * dt;
                else this.x += speed * dt;
            } else {
                if (gameState === 'MENU' || gameState === 'SCORE_MENU' || gameState === 'WALK_IN') this.x -= speed * 0.3 * dt;
                else if (gameState === 'ZOOM_OUT') this.x -= speed * 3 * dt;
                else this.x -= speed * dt;
            }
        }
        if (this.type === 'drone') {
            this.wobbleTimer += this.wobbleSpeed * dt;
            this.currentWobble = Math.sin(this.wobbleTimer) * this.wobbleAmp;
            if (this.droneIndex === 6 && !this.isFalling && !this.isGuidedDescending && this.speedMult > 0) {
                if (this.movingRight) {
                    if (!this.isScriptedDescending && this.x > this.descendTriggerX) {
                        this.isScriptedDescending = true;
                        this.scriptedFallVy = (SCREEN_HEIGHT - this.y) / ((SCREEN_WIDTH * 0.75) / speed);
                        this.wobbleAmp *= 3; this.wobbleSpeed *= 3;
                    }
                } else {
                    if (!this.isScriptedDescending && this.x < this.descendTriggerX) {
                        this.isScriptedDescending = true;
                        this.scriptedFallVy = (SCREEN_HEIGHT - this.y) / ((SCREEN_WIDTH * 0.75) / speed);
                        this.wobbleAmp *= 3; this.wobbleSpeed *= 3;
                    }
                }
            }
            if (this.isFalling || this.isScriptedDescending) {
                this.y += (this.isFalling ? this.fallVy : this.scriptedFallVy) * dt;
                if (this.isFalling) this.rotation += this.rotationSpeed * dt;
                if (this.y + this.h >= SCREEN_HEIGHT) {
                    this.markedForDeletion = true;
                    spawnParticles(this.x + this.w / 2, this.y + this.h, ['#8D4645', '#DA6A5C', '#E99467', '#F1B576'], 40);
                } else if (obsArray) {
                    obsArray.forEach(other => {
                        if (other !== this && !other.markedForDeletion && colliderect(this.getRect(), other.getRect())) {
                            if (other.type === 'mailman' || other.type === 'bike') {
                                this.markedForDeletion = true;
                                other.markedForDeletion = true;
                                spawnParticles(other.x + other.w / 2, other.y + other.h / 2, ['#8D4645', '#DA6A5C', '#E99467', '#EBD188'], 50);
                            } else if (other.type === 'drone' && !other.isFalling) {
                                other.isFalling = true;
                                other.fallVy = (SCREEN_HEIGHT - other.y) / ((SCREEN_WIDTH / 4) / currentObsSpeed);
                                this.rotationSpeed = this.rotationSpeed || 0.05;
                                other.rotationSpeed = -this.rotationSpeed;
                                spawnParticles(other.x + other.w / 2, other.y + other.h / 2, ['#8D4645', '#BA5851'], 20);
                            }
                        }
                    });
                }
            }
        }
    }

    draw() {
        let drawY = this.y + this.currentWobble;
        if (this.domImg) {
            let rotStr = this.rotation ? `rotate(${this.rotation}rad)` : '';
            this.domImg.style.transform = `translate(${this.x}px, ${drawY}px) ${this.movingRight ? 'scaleX(-1)' : ''}${rotStr}`;
        } else {
            if (this.img && this.img.complete && this.img.naturalWidth > 0) {
                if (this.rotation) {
                    ctx.save();
                    ctx.translate(this.x + this.w / 2, drawY + this.h / 2);
                    ctx.rotate(this.rotation);
                    ctx.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
                    ctx.restore();
                } else {
                    ctx.drawImage(this.img, this.x, drawY, this.w, this.h);
                }
            }
        }
    }

    getRect() {
        let hitY = this.y + this.currentWobble;
        if (this.type === 'mailman' || this.type === 'bike')
            return { x: this.x + this.w * 0.3, y: hitY + this.h * 0.1, w: this.w * 0.4, h: this.h * 0.85 };
        if (this.type === 'drone') {
            if (this.droneIndex === 6)
                return { x: this.x + this.w * 0.3, y: hitY + this.h * 0.05, w: this.w * 0.4, h: this.h * 0.95 };
            return { x: this.x + this.w * 0.3, y: hitY + this.h * 0.3, w: this.w * 0.4, h: this.h * 0.7 };
        }
    }
}

class MailIcon {
    constructor(lane, stationary, fixedX, fixedY) {
        stationary = stationary || false;
        fixedX = fixedX !== undefined ? fixedX : null;
        fixedY = fixedY !== undefined ? fixedY : null;
        this.x = stationary && fixedX !== null ? fixedX : SCREEN_WIDTH;
        this.w = 80 * ITEM_SCALE; this.h = 80 * ITEM_SCALE;
        const laneHeight = (SCREEN_HEIGHT * (2 / 3)) / 3;
        this.y = stationary && fixedY !== null ? fixedY : lane * laneHeight + laneHeight / 2 - this.h / 2;
        this.collected = false;
        this.stationary = stationary;
        this.domImg = document.createElement('img');
        this.domImg.src = images['mail'].src;
        this.domImg.className = 'apng-sprite';
        this.domImg.style.width = this.w + 'px';
        this.domImg.style.height = this.h + 'px';
        apngContainer.appendChild(this.domImg);
    }
    update() { if (!this.stationary) this.x -= currentObsSpeed * dt; }
    draw() {
        if (!this.collected) {
            this.domImg.style.display = 'block';
            this.domImg.style.transform = `translate(${this.x}px, ${this.y}px)`;
        } else { this.domImg.style.display = 'none'; }
    }
    getRect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
}

class BoneItem {
    constructor(lane, stationary, fixedX, fixedY) {
        stationary = stationary || false;
        fixedX = fixedX !== undefined ? fixedX : null;
        fixedY = fixedY !== undefined ? fixedY : null;
        this.x = stationary && fixedX !== null ? fixedX : SCREEN_WIDTH;
        this.w = 60 * ITEM_SCALE; this.h = 50 * ITEM_SCALE;
        const laneHeight = (SCREEN_HEIGHT * (2 / 3)) / 3;
        this.y = stationary && fixedY !== null ? fixedY : lane * laneHeight + laneHeight / 2 - this.h / 2;
        this.collected = false;
        this.stationary = stationary;
        this.domImg = document.createElement('div');
        this.domImg.className = 'apng-sprite';
        this.domImg.style.width = this.w + 'px';
        this.domImg.style.height = this.h + 'px';
        this.domImg.style.display = 'flex';
        this.domImg.style.alignItems = 'center';
        this.domImg.style.justifyContent = 'center';
        this.domImg.innerHTML = `<span class="bone-spin"><svg width="${45 * ITEM_SCALE}" height="${45 * ITEM_SCALE}" viewBox="0 0 24 24" fill="#F7E3A9" stroke="#8D4645" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c0 .28.22.5.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5l7-7z"></path></svg></span>`;
        apngContainer.appendChild(this.domImg);
    }
    update() { if (!this.stationary) this.x -= currentObsSpeed * dt; }
    draw() {
        if (!this.collected) {
            this.domImg.style.display = 'flex';
            this.domImg.style.transform = `translate(${this.x}px, ${this.y}px)`;
        } else { this.domImg.style.display = 'none'; }
    }
    getRect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
}

let corg, obstacles, icons, bones, background, score = 0, topScore = 0, lastSpawn = 0;
let lastOpenLanes = [0, 1, 2];

function initMenu() {
    if (obstacles) obstacles.forEach(o => { if (o.domImg) o.domImg.remove(); });
    if (icons) icons.forEach(m => { if (m.domImg) m.domImg.remove(); });
    if (bones) bones.forEach(b => { if (b.domImg) b.domImg.remove(); });

    corgiJumpOverlay.style.display = 'none';
    corgiWalkOverlay.style.display = 'none';
    corgiStandOverlay.style.display = 'none';
    corgiDiveOverlay.style.display = 'none';

    startMenu.style.display = 'flex';
    levelMenu.style.display = 'none';
    scoreMenu.style.display = 'none';
    pauseMenu.style.display = 'none';
    controlsMenu.style.display = 'none';
    objectiveMenu.style.display = 'none';
    devMenu.style.display = 'none';
    tutorialMenu.style.display = 'none';
    codecMenu.style.display = 'none';

    hudScore.style.display = 'none';
    hudLevelInd.style.display = 'none';
    tutorialProgressHUD.style.display = 'none';
    hudHealth.style.display = 'none';
    hudCountdown.style.display = 'none';
    hudGameover.style.display = 'none';

    corg = new Corg();
    obstacles = []; icons = []; bones = []; particles = [];
    background = new ParallaxBackground();
    cameraZoom = 1.0;
    currentObsSpeed = BASE_OBSTACLE_SPEED;
    currentObsFreq = BASE_OBSTACLE_FREQUENCY;
    resize();
    lastOpenLanes = window.isPortraitDevice ? [1, 2] : [0, 1, 2];
    gameState = 'MENU';
    playMode = 'NORMAL';
    lastTime = performance.now();
    updateDevButtonVisibility();
}

function startGame(mode, devEnemy, tutList, startLevel) {
    mode = mode || 'NORMAL';
    devEnemy = devEnemy || null;
    tutList = tutList || [];
    startLevel = startLevel || 1;

    if (obstacles) obstacles.forEach(o => { if (o.domImg) o.domImg.remove(); });
    if (icons) icons.forEach(m => { if (m.domImg) m.domImg.remove(); });
    if (bones) bones.forEach(b => { if (b.domImg) b.domImg.remove(); });

    score = 0;
    currentHealth = MAX_HEALTH;
    currentLevel = startLevel;
    levelCompleteTriggered = false;
    updateHealthHUD();
    startMenu.style.display = 'none';
    pauseMenu.style.display = 'none';
    devMenu.style.display = 'none';
    tutorialMenu.style.display = 'none';
    levelMenu.style.display = 'none';
    codecMenu.style.display = 'none';
    hudScore.style.display = 'none';
    hudLevelInd.style.display = 'none';
    tutorialProgressHUD.style.display = 'none';
    hudHealth.style.display = 'none';

    corg = new Corg();
    obstacles = []; icons = []; bones = []; particles = [];
    lastOpenLanes = window.isPortraitDevice ? [1, 2] : [0, 1, 2];

    playMode = mode;
    if (playMode === 'DEV') {
        currentDevEnemy = devEnemy;
    } else if (playMode === 'TUTORIAL') {
        tutorialQueue = tutList;
        isAllTutorials = tutList.length > 1;
        currentTutType = null;
        tutPhase = 0;
    }
    if (startLevel === 1) {
        bgm.currentTime = 0;
        bgm.play().catch(e => console.log("Audio play blocked", e));
    } else {
        bgm.pause();
    }
    gameState = 'ZOOM_OUT';
}

function quickRestart() {
    if (playMode === 'TUTORIAL') return;
    if (obstacles) obstacles.forEach(o => { if (o.domImg) o.domImg.remove(); });
    if (icons) icons.forEach(m => { if (m.domImg) m.domImg.remove(); });
    if (bones) bones.forEach(b => { if (b.domImg) b.domImg.remove(); });

    hudGameover.style.display = 'none';
    hudCountdown.style.display = 'none';
    corgiJumpOverlay.style.display = 'none';
    corgiWalkOverlay.style.display = 'none';
    corgiStandOverlay.style.display = 'none';
    corgiDiveOverlay.style.display = 'none';

    corg = new Corg();
    corg.x = 100;
    obstacles = []; icons = []; bones = []; particles = [];
    score = 0;
    levelCompleteTriggered = false;
    currentHealth = MAX_HEALTH;
    updateHealthHUD();
    invulnTimer = 0;
    lastOpenLanes = window.isPortraitDevice ? [1, 2] : [0, 1, 2];
    gameState = 'PLAY';
    lastTime = performance.now();
    lastSpawn = lastTime;
}

const level1Cutscene = [
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "Hmph. So you're the 'Super Corg' I've been hearing about. You can call me Agent Barklee, and you need to listen up before you get yourself clipped." },
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "You think you're the first one to notice something is rotten in the neighborhood? You've been running around snagging those ten pieces of mail trying to piece it together, but the top brass of the dog world has known the truth since pre-history. Humanity completely forgot, but we never did—" },
    { type: 'action', text: "[SFX: BZZZZT! CRACKLE! Transmission abruptly cuts to heavy static.]\n\nThe screen erupts into static, cutting Barklee off completely. Shadows stretch across the environment as local mail carriers violently rip off their human disguises, revealing scaly, hissing reptilians underneath!\n\nSuper Corg springs into action, dodging razor-sharp claws and biting back, but the reptilian numbers quickly overwhelm the perimeter.\n\n[SFX: THWACK! THWACK! THWACK!]\nOut of nowhere, a heavy artillery barrage of neon-green tennis balls rains down from above. They bounce erratically into the enemy crowd before detonating in a brilliant flash of kinetic energy, instantly vaporizing the remaining reptilian forces." },
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "Well, you know what they look like now. No time to celebrate, kid—it all started 5,000 years ago when the first scales infiltrated the Mesopotamian courier networks..." },
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "...They realized back then that whoever controls the distribution of written scrolls controls the flow of information itself. They traded their desert sands for bureaucratic marble, weaving themselves into the very fabric of human infrastructure. Humanity grew lazy, blind, and dependent on the system, completely forgetting the ancient cold-blooded threat right beneath their noses. But our ancestors—the first Pharaoh hounds, the imperial guardians—we watched them adapt from parchment to post offices." },
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "Now, they're using modern tracking data and logistics to map out every human stronghold, preparing for the final harvest. You sticking your furry nose into those ten envelopes tipped them off that someone was finally waking up." },
    { type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "That little ambush was just a taste of what's coming, and my tennis-ball mortar team won't always be around to bail you out. If you want to shut down this conspiracy for good, your next stop is the main sorting facility downtown. I'll keep this channel open, but from here on out, every mailman you see is a potential predator. Barklee out." }
];

let activeCutscene = null;
let cutsceneIndex = 0;

function startCodecSequence(script, onComplete) {
    bgm.pause();
    gameState = 'CUTSCENE';
    activeCutscene = script;
    cutsceneIndex = 0;
    window.cutsceneNextAction = onComplete;
    codecMenu.style.display = 'flex';
    renderCodecFrame();
}

function renderCodecFrame() {
    if (cutsceneIndex >= activeCutscene.length) {
        codecMenu.style.display = 'none';
        if (window.cutsceneNextAction) window.cutsceneNextAction();
        return;
    }
    const frame = activeCutscene[cutsceneIndex];
    const nameEl = document.getElementById('codec-name');
    const textEl = document.getElementById('codec-text');
    const imgEl = document.getElementById('codec-img');
if (frame.type === 'action') {
    nameEl.innerText = 'SYSTEM ACTION / STATIC';
    nameEl.style.color = '#da6a5c';
    textEl.innerHTML = '<span style="color:#da6a5c;font-style:italic;">' + frame.text.replace(/\n/g, '<br>') + '</span>';
    imgEl.className = 'codec-portrait static';
    imgEl.src = 'assets/RepLogo.png';
} else {
    nameEl.innerText = frame.speaker;
    nameEl.style.color = '#679481';
    textEl.innerText = frame.text;
    imgEl.className = 'codec-portrait';
    imgEl.src = frame.image;
}
}

function advanceCodec() {
    if (gameState !== 'CUTSCENE') return;
    cutsceneIndex++;
    renderCodecFrame();
}

codecMenu.addEventListener('click', advanceCodec);

function startNextTutorial(isInitial) {
    isInitial = isInitial || false;
    if (tutorialQueue.length === 0) {
        initMenu();
        if (!isAllTutorials) {
            document.getElementById('start-menu').style.display = 'none';
            document.getElementById('tutorial-menu').style.display = 'flex';
        }
        return;
    }
    currentTutType = tutorialQueue.shift();
    tutPhase = 0;
    tutProgress = 0;
    if (!isInitial) { corg = new Corg(); corg.x = 100; }
    if (obstacles) obstacles.forEach(o => { if (o.domImg) o.domImg.remove(); });
    if (icons) icons.forEach(m => { if (m.domImg) m.domImg.remove(); });
    if (bones) bones.forEach(b => { if (b.domImg) b.domImg.remove(); });
    obstacles = []; icons = []; bones = []; particles = [];
    updateHealthHUD();
    tutorialProgressHUD.style.display = 'none';
    if (currentTutType === 'movement') {
        showTutorialMsg("Collect all the mail to complete.");
    } else if (currentTutType === 'sploot') {
        tutGoal = 3;
        showTutorialMsg("Hold DOWN before landing on a drone to Sploot Bomb it! Destroy 3 drones.");
    } else if (currentTutType === 'control') {
        tutGoal = 3;
        showTutorialMsg("Land on a drone, then press DOWN to steer it to the ground. Destroy 3 drones.");
    } else if (currentTutType === 'health') {
        currentHealth = 1;
        updateHealthHUD();
        showTutorialMsg("Collect bones to restore health. Each heart in the top right represents one health.");
    }
}

function showTutorialMsg(msg) {
    gameState = 'TUTORIAL_TEXT';
    tutorialMsgBox.innerHTML = msg;
    tutorialMsgBox.style.display = 'block';
}

function dismissTutorialMsg() {
    if (gameState !== 'TUTORIAL_TEXT') return;
    tutorialMsgBox.style.display = 'none';
    if (tutPhase === 'congrats') { startNextTutorial(false); return; }
    gameState = 'PLAY';
    lastTime = performance.now();
    if (currentTutType === 'movement') {
        if (tutPhase === 0) {
            icons.push(new MailIcon(window.isPortraitDevice ? 1 : 0, true, SCREEN_WIDTH - 200, SCREEN_HEIGHT / 2));
            tutPhase = 1;
        }
    } else if (currentTutType === 'sploot' || currentTutType === 'control') {
        tutorialProgressHUD.style.display = 'block';
        tutorialProgressHUD.innerText = tutProgress + '/' + tutGoal;
        if (tutPhase === 0) { spawnTutorialDrone(); tutPhase = 1; }
    } else if (currentTutType === 'health') {
        if (tutPhase === 0) {
            let minL = window.isPortraitDevice ? 1 : 0;
            bones.push(new BoneItem(minL, true, 400 + Math.random() * 600, 200 + Math.random() * 400));
            bones.push(new BoneItem(minL, true, 600 + Math.random() * 600, 200 + Math.random() * 400));
            tutPhase = 1;
        }
    }
}

function spawnTutorialDrone() {
    let laneOptions = window.isPortraitDevice ? [1, 2] : [0, 1, 2];
    let lane = laneOptions[Math.floor(Math.random() * laneOptions.length)];
    let basicDrones = ['1a', '1b', '1c', '1d', '1e'];
    let type = 'drone' + (Math.random() < 0.3 ? '3' : basicDrones[Math.floor(Math.random() * basicDrones.length)]);
    obstacles.push(new Obstacle('drone', lane, false, false, type, true));
}

const addBtnListener = function(id, fn) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', fn);
    btn.addEventListener('touchstart', function(e) { e.preventDefault(); fn(); }, { passive: false });
};

addBtnListener('start-btn', function() { startGame('NORMAL', null, [], 1); });
addBtnListener('level-select-btn', function() { startMenu.style.display = 'none'; levelMenu.style.display = 'flex'; updateLevelSelectUI(); });
addBtnListener('level-back-btn', function() { levelMenu.style.display = 'none'; startMenu.style.display = 'flex'; });
addBtnListener('login-btn', async function() {
    if (!auth || !provider) return;
    if (currentUser && !currentUser.isAnonymous) {
        // Already signed in — log out
        try { await auth.signOut(); await auth.signInAnonymously(); } catch(e) { console.warn("Logout failed:", e); }
    } else {
        try { await auth.signInWithPopup(provider); } catch(e) { console.warn("Login failed:", e); }
    }
});
addBtnListener('dev-start-btn', function() { startMenu.style.display = 'none'; devMenu.style.display = 'flex'; previousMenuState = 'MENU'; });
addBtnListener('dev-back-btn', function() { devMenu.style.display = 'none'; if (previousMenuState === 'PAUSE') pauseMenu.style.display = 'flex'; else startMenu.style.display = 'flex'; });
addBtnListener('test-cutscene-btn', function() {
    devMenu.style.display = 'none';
    startCodecSequence(level1Cutscene, function() { initMenu(); document.getElementById('start-menu').style.display = 'none'; devMenu.style.display = 'flex'; });
});
document.querySelectorAll('.dev-enemy-btn').forEach(function(btn) {
    var fn = function() { startGame('DEV', btn.getAttribute('data-enemy')); };
    btn.addEventListener('click', fn);
    btn.addEventListener('touchstart', function(e) { e.preventDefault(); fn(); }, { passive: false });
});
addBtnListener('tut-start-btn', function() { startMenu.style.display = 'none'; tutorialMenu.style.display = 'flex'; previousMenuState = 'MENU'; });
addBtnListener('tut-back-btn', function() { tutorialMenu.style.display = 'none'; if (previousMenuState === 'PAUSE') pauseMenu.style.display = 'flex'; else startMenu.style.display = 'flex'; });
document.querySelectorAll('.tut-btn').forEach(function(btn) {
    var fn = function() {
        var t = btn.getAttribute('data-tut');
        var list = t === 'all' ? ['movement', 'sploot', 'control', 'health'] : [t];
        startGame('TUTORIAL', null, list);
    };
    btn.addEventListener('click', fn);
    btn.addEventListener('touchstart', function(e) { e.preventDefault(); fn(); }, { passive: false });
});
addBtnListener('score-btn', function() { startMenu.style.display = 'none'; scoreMenu.style.display = 'flex'; document.getElementById('score-title').innerText = 'HIGH SCORE: ' + topScore; gameState = 'SCORE_MENU'; });
addBtnListener('back-btn', function() { scoreMenu.style.display = 'none'; startMenu.style.display = 'flex'; gameState = 'MENU'; });
addBtnListener('controls-start-btn', function() { previousMenuState = 'MENU'; startMenu.style.display = 'none'; controlsMenu.style.display = 'flex'; gameState = 'CONTROLS'; });
addBtnListener('controls-pause-btn', function() { previousMenuState = 'PAUSE'; pauseMenu.style.display = 'none'; controlsMenu.style.display = 'flex'; gameState = 'CONTROLS'; });
addBtnListener('controls-back-btn', function() { controlsMenu.style.display = 'none'; if (previousMenuState === 'PAUSE') { pauseMenu.style.display = 'flex'; gameState = 'PAUSE'; } else { startMenu.style.display = 'flex'; gameState = 'MENU'; } });
addBtnListener('resume-btn', function() { pauseMenu.style.display = 'none'; gameState = 'PLAY'; lastTime = performance.now(); });
addBtnListener('objective-btn', function() {
    pauseMenu.style.display = 'none'; objectiveMenu.style.display = 'flex';
    document.getElementById('objective-text').innerText = playMode === 'NORMAL' ? 'COLLECT ' + (levelGoals[currentLevel] || 999) + ' PIECES OF MAIL' : 'SURVIVE AND PRACTICE';
    gameState = 'OBJECTIVE';
});
addBtnListener('objective-back-btn', function() { objectiveMenu.style.display = 'none'; pauseMenu.style.display = 'flex'; gameState = 'PAUSE'; });
addBtnListener('quit-btn', initMenu);
addBtnListener('main-menu-btn', initMenu);
addBtnListener('quick-restart-btn', quickRestart);

function getGameTouch(t) {
    if (window.innerHeight > window.innerWidth) return { x: t.clientY, y: window.innerWidth - t.clientX };
    return { x: t.clientX, y: t.clientY };
}

let leftTouch = { active: false, id: null, startX: 0, startY: 0, currentX: 0, currentY: 0 };
let rightTouch = { active: false, id: null, startX: 0, startY: 0, currentY: 0, startTime: 0, moved: false };
const TAP_THRESHOLD = 30;
const TIME_THRESHOLD = 300;

window.addEventListener('touchstart', function(e) {
    if (e.target.closest('.menu-btn') || e.target.closest('#codec-menu')) return;
    if (gameState === 'TUTORIAL_TEXT') { e.preventDefault(); dismissTutorialMsg(); return; }
    let gameW = window.innerHeight > window.innerWidth ? window.innerHeight : window.innerWidth;
    Array.from(e.changedTouches).forEach(function(t) {
        let pos = getGameTouch(t);
        if (pos.x < gameW / 2) {
            leftTouch = { active: true, id: t.identifier, startX: pos.x, startY: pos.y, currentX: pos.x, currentY: pos.y };
        } else {
            rightTouch = { active: true, id: t.identifier, startX: pos.x, startY: pos.y, currentY: pos.y, startTime: performance.now(), moved: false };
        }
    });
}, { passive: false });

window.addEventListener('touchmove', function(e) {
    if (gameState === 'PLAY') e.preventDefault();
    Array.from(e.changedTouches).forEach(function(t) {
        let pos = getGameTouch(t);
        if (leftTouch.active && t.identifier === leftTouch.id) {
            leftTouch.currentX = pos.x; leftTouch.currentY = pos.y;
            let dx = leftTouch.currentX - leftTouch.startX;
            let dy = leftTouch.currentY - leftTouch.startY;
            keys.left = dx < -TAP_THRESHOLD;
            keys.right = dx > TAP_THRESHOLD;
            keys.down = dy > TAP_THRESHOLD;
        }
        if (rightTouch.active && t.identifier === rightTouch.id) {
            rightTouch.currentY = pos.y;
            let dy = rightTouch.currentY - rightTouch.startY;
            if (Math.abs(dy) > TAP_THRESHOLD) {
                rightTouch.moved = true;
                if (dy < -TAP_THRESHOLD && gameState === 'PLAY') {
                    keys.shift = true;
                    setTimeout(function() { keys.shift = false; }, 100);
                    rightTouch.active = false;
                }
            }
        }
    });
}, { passive: false });

var handleTouchEnd = function(e) {
    Array.from(e.changedTouches).forEach(function(t) {
        if (leftTouch.active && t.identifier === leftTouch.id) {
            leftTouch.active = false;
            keys.left = false; keys.right = false; keys.down = false;
        }
        if (rightTouch.active && t.identifier === rightTouch.id) {
            let duration = performance.now() - rightTouch.startTime;
            if (!rightTouch.moved && duration < TIME_THRESHOLD) {
                if (gameState === 'PLAY') corg.flap();
                else if (gameState === 'GAMEOVER' && playMode !== 'TUTORIAL') quickRestart();
                else if (gameState === 'MENU') startGame('NORMAL', null, [], currentLevel);
            }
            rightTouch.active = false;
        }
    });
};
window.addEventListener('touchend', handleTouchEnd);
window.addEventListener('touchcancel', handleTouchEnd);

function loop(t) {
    try {
        const frameTime = t - lastTime;
        lastTime = t;
        if (gameState === 'PAUSE' || gameState === 'CONTROLS' || gameState === 'OBJECTIVE' || gameState === 'TUTORIAL_TEXT') {
            requestAnimationFrame(loop); return;
        }
        dt = Math.min(frameTime / 16.67, 2);

        if (gameState === 'PLAY' || gameState === 'GAMEOVER') {
            if (playMode === 'NORMAL') {
                hudScore.style.display = 'block';
                hudScore.innerText = 'SCORE: ' + score + '/' + (levelGoals[currentLevel] || '∞');
                hudLevelInd.style.display = 'block';
                hudLevelInd.innerText = 'LVL ' + currentLevel;
            } else {
                hudLevelInd.style.display = 'none';
            }
            if (playMode === 'NORMAL' || playMode === 'TUTORIAL' || playMode === 'DEV') {
                hudHealth.style.display = 'flex';
            }
        } else {
            hudScore.style.display = 'none';
            hudHealth.style.display = 'none';
            hudLevelInd.style.display = 'none';
        }

        ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

        if (gameState !== 'CUTSCENE') background.update();
        background.draw();

        if (gameState === 'PLAY' && playMode === 'NORMAL') {
            let dm = Math.min(score, 25) / 25;
            currentObsSpeed = BASE_OBSTACLE_SPEED + dm * 5.0 + currentLevel * 0.5;
            currentObsFreq = BASE_OBSTACLE_FREQUENCY - dm * 600 - currentLevel * 50;
        } else {
            currentObsSpeed = BASE_OBSTACLE_SPEED;
        }

        if (gameState === 'MENU' || gameState === 'SCORE_MENU' || (gameState === 'WALK_IN' && playMode === 'NORMAL')) {
            if (t - lastSpawn > BASE_OBSTACLE_FREQUENCY * 2.5) {
                lastSpawn = t;
                let minL = window.isPortraitDevice ? 1 : 0;
                obstacles.push(new Obstacle('drone', Math.floor(Math.random() * (3 - minL)) + minL));
            }
        }
        if (gameState === 'MENU' || gameState === 'SCORE_MENU' || gameState === 'WALK_IN') {
            obstacles.forEach(function(o) { o.update(obstacles, frameTime); o.draw(); });
        }

        if (gameState === 'ZOOM_OUT') {
            obstacles.forEach(function(o) { o.update(obstacles, frameTime); o.draw(); });
            obstacles = obstacles.filter(function(o) {
                if (o.markedForDeletion) { if (o.domImg) o.domImg.remove(); return false; }
                if (o.movingRight && o.x < SCREEN_WIDTH + 100) return true;
                if (!o.movingRight && o.x > -o.w - 100) return true;
                if (o.domImg) o.domImg.remove(); return false;
            });
            gameState = 'WALK_IN';
        } else if (gameState === 'WALK_IN') {
            corg.x += 4 * dt;
            corg.update(frameTime);
            corg.draw();
            if (corg.x >= 100) {
                corg.x = 100;
                if (playMode === 'NORMAL') {
                    gameState = 'COUNTDOWN';
                    countdownTimer = 3000;
                } else {
                    if (playMode === 'TUTORIAL' && !currentTutType) startNextTutorial(true);
                    else gameState = 'PLAY';
                    lastSpawn = t;
                }
            }
        } else if (gameState === 'COUNTDOWN') {
            countdownTimer -= frameTime;
            corg.update(frameTime);
            corg.draw();
            let currentNum = Math.ceil(countdownTimer / 1000);
            if (currentNum > 0) {
                hudCountdown.style.display = 'block';
                hudCountdown.innerText = currentNum.toString();
            } else {
                hudCountdown.style.display = 'none';
                if (playMode === 'TUTORIAL' && !currentTutType) startNextTutorial(true);
                else gameState = 'PLAY';
                lastSpawn = t;
            }
        } else if (gameState === 'CUTSCENE') {
            corg.update(frameTime);
            corg.draw();
            obstacles.forEach(function(o) { o.draw(); });
            icons.forEach(function(m) { m.draw(); });
            bones.forEach(function(b) { b.draw(); });
        } else if (gameState === 'PLAY') {
            corg.update(frameTime);

            if (playMode === 'NORMAL') {
                let goal = levelGoals[currentLevel] || 999;
                if (score >= goal && !levelCompleteTriggered) {
                    levelCompleteTriggered = true;
                    saveProgress(currentLevel);
                    let nextLevel = currentLevel + 1;
                    if (currentLevel === 1) {
                        startCodecSequence(level1Cutscene, function() { startGame('NORMAL', null, [], nextLevel); });
                    } else if (currentLevel < TOTAL_LEVELS) {
                        startCodecSequence([{ type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: 'Excellent! Sector cleared. Let\'s move deeper into the suburbs for Level ' + nextLevel + '!' }], function() { startGame('NORMAL', null, [], nextLevel); });
                    } else {
                        startCodecSequence([{ type: 'dialogue', speaker: 'AGENT BARKLEE', image: 'assets/agentBarklee.png', text: "YOU DID IT! The mail has been delivered and the neighborhood is safe. YOU ARE THE GOODEST DOG!" }], initMenu);
                    }
                }
                if (t - lastSpawn > currentObsFreq && !levelCompleteTriggered) {
                    lastSpawn = t;
                    let minLane = window.isPortraitDevice ? 1 : 0;
                    let numLanes = 4 - minLane;  // 3 drone lanes + 1 mailman lane
                    let droneLaneCount = 3 - minLane;  // actual drone lanes only (no mailman)
                    let numOpenLanes = Math.random() < 1 / 30 ? 1 : Math.min(Math.floor(Math.random() * (droneLaneCount - 1)) + 2, droneLaneCount);
                    let guaranteedOpen = Math.max(minLane, Math.min(2, lastOpenLanes[Math.floor(Math.random() * lastOpenLanes.length)] + Math.floor(Math.random() * 3) - 1));
                    let openLanes = new Set([guaranteedOpen]);
                    while (openLanes.size < numOpenLanes) openLanes.add(Math.floor(Math.random() * (3 - minLane)) + minLane);
                    lastOpenLanes = Array.from(openLanes).filter(function(l) { return l <= 2; });
                    let allLanes = window.isPortraitDevice ? [1, 2, 3] : [0, 1, 2, 3];  // lane 3 = mailman/bike
                    let avail = allLanes.filter(function(l) { return !openLanes.has(l); });
                    let canSpawnBike = score >= 8 || currentLevel > 1;
                    let canSpawnBigDrone = score >= 3 || currentLevel > 1;
                    if (avail.includes(3)) {
                        if (canSpawnBike && Math.random() < 0.20) obstacles.push(new Obstacle('bike'));
                        else obstacles.push(new Obstacle('mailman'));
                        avail = avail.filter(function(l) { return l !== 3; });
                    }
                    if (canSpawnBigDrone && Math.random() < 0.25) {
                        for (let i = minLane; i <= 1; i++) {  // big drone spans 2 adjacent drone lanes (0+1 or 1+2)
                            if (avail.includes(i) && avail.includes(i + 1)) {
                                obstacles.push(new Obstacle('drone', i, true, canSpawnBike && Math.random() < 0.5));
                                avail = avail.filter(function(l) { return l !== i && l !== i + 1; });
                                break;
                            }
                        }
                    }
                    avail.forEach(function(lane) { obstacles.push(new Obstacle('drone', lane)); });
                    if (Math.random() < 0.35) {
                        let targetLane = lastOpenLanes[Math.floor(Math.random() * lastOpenLanes.length)];
                        if (Math.random() < 0.15) bones.push(new BoneItem(targetLane));
                        else icons.push(new MailIcon(targetLane));
                    }
                }
            } else if (playMode === 'DEV') {
                if (obstacles.length === 0 && t - lastSpawn > 500) {
                    lastSpawn = t;
                    let minL = window.isPortraitDevice ? 1 : 0;
                    obstacles.push(new Obstacle('any', Math.floor(Math.random() * (3 - minL)) + minL, currentDevEnemy === 'drone4', false, currentDevEnemy));
                }
            }

            if (playMode === 'TUTORIAL') {
                if (currentTutType === 'movement') {
                    if (tutPhase === 1 && icons.length === 0) {
                        let minL = window.isPortraitDevice ? 1 : 0;
                        icons.push(new MailIcon(minL, true, 300, window.isPortraitDevice ? 300 : 200));
                        icons.push(new MailIcon(minL, true, 800, window.isPortraitDevice ? 300 : 200));
                        icons.push(new MailIcon(minL, true, 1300, window.isPortraitDevice ? 300 : 200));
                        tutPhase = 2;
                    } else if (tutPhase === 2 && icons.length === 0) {
                        tutPhase = 'congrats'; showTutorialMsg("Congrats!");
                    }
                } else if (currentTutType === 'sploot' || currentTutType === 'control') {
                    if (tutProgress >= tutGoal && tutPhase !== 'congrats') {
                        tutPhase = 'congrats';
                        tutorialProgressHUD.style.display = 'none';
                        obstacles.forEach(function(o) { if (o.domImg) o.domImg.remove(); });
                        obstacles = [];
                        showTutorialMsg("Congrats!");
                    } else if (tutPhase === 1 && obstacles.length === 0) {
                        spawnTutorialDrone();
                    }
                } else if (currentTutType === 'health') {
                    if (currentHealth >= MAX_HEALTH && tutPhase !== 'congrats') {
                        tutPhase = 'congrats'; showTutorialMsg("Congrats!");
                    }
                }
            }

            obstacles.forEach(function(o) {
                o.update(obstacles, frameTime);
                if (!o.markedForDeletion && gameState === 'PLAY') {
                    let cRect = corg.getRect();
                    let oRect = o.getRect();
                    if (colliderect(cRect, oRect)) {
                        if (o.type === 'drone' && !o.isFalling) {
                            let isLanding = corg.velocity > 0 && (cRect.y + cRect.h * 0.5) < (oRect.y + oRect.h * 0.5);
                            if (isLanding && !corg.isDashing) {
                                if (keys.down) {
                                    o.isFalling = true; o.fallReason = 'sploot';
                                    o.fallVy = (SCREEN_HEIGHT - o.y) / ((SCREEN_WIDTH / 4) / currentObsSpeed);
                                    o.rotationSpeed = 0.05;
                                    spawnParticles(o.x + o.w / 2, o.y, ['#8D4645', '#BA5851', '#C97062'], 30);
                                    invulnTimer = 500; corg.velocity = FLAP_STRENGTH * 0.7;
                                } else { corg.ridingDrone = o; corg.velocity = 0; }
                            } else if (corg.ridingDrone !== o && invulnTimer <= 0 && !corg.isDashing) {
                                currentHealth--;
                                updateHealthHUD();
                                spawnParticles(corg.x + corg.w / 2, corg.y + corg.h / 2, ['#F7E3A9', '#679481', '#DA6A5C', '#8D4645'], 30);
                                if (currentHealth <= 0) gameState = 'GAMEOVER';
                                else { invulnTimer = 2000; corg.velocity = -5; }
                            }
                        } else if ((o.type === 'mailman' || o.type === 'bike') && invulnTimer <= 0 && !corg.isDashing) {
                            currentHealth--;
                            updateHealthHUD();
                            spawnParticles(corg.x + corg.w / 2, corg.y + corg.h / 2, ['#F7E3A9', '#679481', '#DA6A5C', '#8D4645'], 30);
                            if (currentHealth <= 0) gameState = 'GAMEOVER';
                            else { invulnTimer = 2000; corg.velocity = -8; }
                        }
                    }
                    if (playMode === 'TUTORIAL' && o.isFalling && !o.counted) {
                        if (currentTutType === 'sploot' && o.fallReason === 'sploot') {
                            tutProgress++; o.counted = true;
                            tutorialProgressHUD.innerText = tutProgress + '/' + tutGoal;
                        } else if (currentTutType === 'control' && o.fallReason === 'guided') {
                            tutProgress++; o.counted = true;
                            tutorialProgressHUD.innerText = tutProgress + '/' + tutGoal;
                        }
                    }
                }
            });

            icons.forEach(function(m) {
                m.update();
                if (!m.collected && colliderect(corg.getRect(), m.getRect())) {
                    m.collected = true; score++; topScore = Math.max(score, topScore);
                }
            });
            bones.forEach(function(b) {
                b.update();
                if (!b.collected && colliderect(corg.getRect(), b.getRect())) {
                    b.collected = true;
                    if (currentHealth < MAX_HEALTH) { currentHealth++; updateHealthHUD(); }
                }
            });

            icons = icons.filter(function(m) { if (m.collected) { m.domImg.remove(); return false; } if (m.x > -m.w) return true; m.domImg.remove(); return false; });
            bones = bones.filter(function(b) { if (b.collected) { b.domImg.remove(); return false; } if (b.x > -b.w) return true; b.domImg.remove(); return false; });
            obstacles = obstacles.filter(function(o) {
                if (o.markedForDeletion) { if (o.domImg) o.domImg.remove(); return false; }
                if (o.movingRight && o.x < SCREEN_WIDTH + 100) return true;
                if (!o.movingRight && o.x > -o.w - 100) return true;
                if (o.domImg) o.domImg.remove(); return false;
            });

            corg.draw();
            obstacles.forEach(function(o) { o.draw(); });
            icons.forEach(function(m) { m.draw(); });
            bones.forEach(function(b) { b.draw(); });

        } else if (gameState === 'GAMEOVER') {
            obstacles.forEach(function(o) { o.update(obstacles, frameTime); o.draw(); });
            icons.forEach(function(m) { m.update(); m.draw(); });
            bones.forEach(function(b) { b.update(); b.draw(); });
            icons = icons.filter(function(m) { if (m.collected) { m.domImg.remove(); return false; } if (m.x > -m.w) return true; m.domImg.remove(); return false; });
            bones = bones.filter(function(b) { if (b.collected) { b.domImg.remove(); return false; } if (b.x > -b.w) return true; b.domImg.remove(); return false; });
            obstacles = obstacles.filter(function(o) {
                if (o.markedForDeletion) { if (o.domImg) o.domImg.remove(); return false; }
                if (o.movingRight && o.x < SCREEN_WIDTH + 100) return true;
                if (!o.movingRight && o.x > -o.w - 100) return true;
                if (o.domImg) o.domImg.remove(); return false;
            });
            corgiJumpOverlay.style.display = 'none';
            corgiWalkOverlay.style.display = 'none';
            corgiStandOverlay.style.display = 'none';
            corgiDiveOverlay.style.display = 'none';
            if (playMode === 'NORMAL' || playMode === 'DEV') {
                hudGameover.style.display = 'flex';
                document.getElementById('go-score').innerText = 'TOP SCORE: ' + topScore;
            } else if (playMode === 'TUTORIAL') {
                tutorialQueue.unshift(currentTutType);
                startNextTutorial(false);
            }
        }

        if (['PLAY', 'GAMEOVER', 'WALK_IN', 'COUNTDOWN', 'CUTSCENE'].indexOf(gameState) !== -1) {
            particles.forEach(function(p) { p.update(); });
            particles = particles.filter(function(p) { return p.life > 0; });
            particles.forEach(function(p) { p.draw(ctx); });
        }

        requestAnimationFrame(loop);
    } catch (error) {
        ctx.fillStyle = '#8D4645';
        ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        ctx.fillStyle = '#F7E3A9';
        ctx.font = '24px Arial';
        ctx.textAlign = 'left';
        ctx.fillText("CRASH DETECTED! Please share this with Unca G:", 50, 100);
        ctx.fillText(error.message, 50, 150);
        if (error.stack) {
            error.stack.split('\n').slice(0, 10).forEach(function(line, i) { ctx.fillText(line, 50, 200 + i * 30); });
        }
        console.error(error);
    }
}

window.addEventListener('keydown', function(e) {
    if (gameState === 'TUTORIAL_TEXT') { dismissTutorialMsg(); return; }
    if (gameState === 'CUTSCENE') { advanceCodec(); return; }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = true;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = true;
    if (e.code === 'KeyW' || e.code === 'Space' || e.code === 'ArrowUp') {
        if (e.repeat) return;
        if (gameState === 'PLAY') corg.flap();
        else if (gameState === 'GAMEOVER' && playMode !== 'TUTORIAL') quickRestart();
        else if (gameState === 'MENU') startGame('NORMAL', null, [], currentLevel);
    }
    if (e.code === 'Escape') {
        if (gameState === 'PLAY') { gameState = 'PAUSE'; pauseMenu.style.display = 'flex'; }
        else if (gameState === 'PAUSE') { gameState = 'PLAY'; pauseMenu.style.display = 'none'; lastTime = performance.now(); }
        else if (gameState === 'GAMEOVER') initMenu();
        else if (gameState === 'CONTROLS') document.getElementById('controls-back-btn').click();
        else if (gameState === 'OBJECTIVE') document.getElementById('objective-back-btn').click();
        else if (gameState === 'SCORE_MENU') document.getElementById('back-btn').click();
        else if (devMenu.style.display === 'flex') document.getElementById('dev-back-btn').click();
        else if (tutorialMenu.style.display === 'flex') document.getElementById('tut-back-btn').click();
        else if (levelMenu.style.display === 'flex') document.getElementById('level-back-btn').click();
    }
});

window.addEventListener('keyup', function(e) {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = false;
});

window.addEventListener('mousedown', function(e) {
    if (e.target.closest('.menu-btn') || e.target.closest('#codec-menu')) return;
    if (gameState === 'TUTORIAL_TEXT') { dismissTutorialMsg(); return; }
    if (gameState === 'CUTSCENE') { advanceCodec(); return; }
    if (gameState === 'PLAY') corg.flap();
    else if (gameState === 'GAMEOVER' && playMode !== 'TUTORIAL') quickRestart();
});

document.fonts.ready.then(function() {
    resize();
    initMenu();
    requestAnimationFrame(loop);
});
