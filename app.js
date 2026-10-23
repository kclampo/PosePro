/* app.js — TITAN POSE v1.8.4 — real-time posing gate trainer
 *
 * ⚠️ The number on the page comes from version.js (window.APP_VERSION), NOT from
 * this comment. They drifted apart once already: this header said v1.8.3 while
 * version.js and the export both said v1.8.4. Bump version.js on release; treat
 * this line as documentation that must match it.
 *
 * Runs 100% on-device. No network calls after load. No credentials.
 * MediaPipe Pose Landmarker (WASM/GPU) -> body-relative measurements -> gates -> green/red.
 *
 * DESIGN RULE: the screen never shows a raw number to the athlete.
 * It colours the joint and prints ONE plain-language cue.
 * Numbers appear only in the export, for the coach.
 *
 * v1.1 (2026-10-21) — four fixes from Kevin's field test:
 *   1. CAMERA FLIP — rear/front button, with the live camera mode shown.
 *   2. MANUAL POSE NAV — PREV / NEXT, works mid-hold, records partial holds.
 *   3. VOICE — speaks the pose and its cues on arrival, and speaks corrections.
 *      This is what makes BACK poses usable: he is facing away from the screen.
 *   4. FRAMING POSE FIRST — the session always opens on a FRONT pose so he can
 *      confirm he is in frame before turning his back.
 */

import { PoseLandmarker, FilesetResolver }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

const HOLD_MS = 10_000;      // required green hold
const READY_MS = 800;        // must be green this long before the hold clock starts
const CUE_REPEAT_MS = 6_000; // never repeat the same spoken cue faster than this
const SPEAK_MIN_GAP  = 2_200; // hard floor between ANY two spoken cues
const OUT_OF_FRAME_MS = 8_000;

// ── landmarks ────────────────────────────────────────────────────────────
const L = { NOSE:0, LEAR:7, REAR:8, LSH:11, RSH:12, LEL:13, REL:14, LWR:15, RWR:16,
            LHIP:23, RHIP:24, LKN:25, RKN:26, LAN:27, RAN:28 };

// ── dom ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const video = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const elPose = $('poseName'), elCue = $('cue'), elTimer = $('timer'),
      elReady = $('ready'), elProgress = $('progress'), elCount = $('poseCount'),
      elGateList = $('gateList'), elStart = $('startBtn'), elStop = $('stopBtn'),
      elExport = $('exportBtn'), elSummary = $('summary'), elCopy = $('copyBtn'),
      elFlip = $('flipBtn'), elVoice = $('voiceBtn'),
      elPrev = $('prevBtn'), elNext = $('nextBtn'), elCamInfo = $('camInfo');

let landmarker = null, stream = null, running = false, lastVideoTime = -1;
let order = [], idx = 0, state = 'idle';
let greenRunStart = 0, holdAccum = 0, lastTick = 0;
let session = null, currentRecord = null;
// Session t0. Everything timing-related is milliseconds since this moment, so
// set-time and transition-time stay comparable even if the athlete pauses.
let t0 = 0;

// ── light meter ──────────────────────────────────────────────────────────
// MEASURED, NOT GUESSED (2026-10-22). Two tests on known-good stage frames:
//   1. Clean darkening: MediaPipe still found the athlete at mean luma ~11.
//      So "darkness" alone barely matters — the camera's own auto-exposure
//      keeps the delivered frame usable.
//   2. Dark + NOISE is what actually kills it. At luma 33 with sensor noise
//      sigma 16, detection failed 3/3. At luma 24 with sigma 8 it passed 3/3.
//   ⚠️ NEITHER statistic predicts failure on its own: detected frames ran
//   luma 24-82, failed frames 26-51 — the ranges OVERLAP. There is no single
//   scalar threshold, so this meter does NOT hard-gate anything.
// What it does instead: report the numbers, and DISAMBIGUATE the message when
// the landmarker cannot see the athlete — "too dark" vs "step into frame".
const LIGHT_LUMA_DIM = 45;      // below this, and we suspect the room
const lightCv = document.createElement('canvas');
lightCv.width = 64; lightCv.height = 48;
const lightCtx = lightCv.getContext('2d', { willReadFrequently: true });
let light = { luma: null, noise: null };
let camBase = '';

function sampleLight() {
  if (!video.videoWidth) return;
  try {
    lightCtx.drawImage(video, 0, 0, lightCv.width, lightCv.height);
    const d = lightCtx.getImageData(0, 0, lightCv.width, lightCv.height).data;
    const W = lightCv.width, H = lightCv.height;
    const g = new Float32Array(W * H);
    let sum = 0;
    for (let i = 0, p = 0; p < g.length; i += 4, p++) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g[p] = y; sum += y;
    }
    let lap = 0, c = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      lap += Math.abs(4 * g[i] - g[i - W] - g[i + W] - g[i - 1] - g[i + 1]);
      c++;
    }
    light = { luma: +(sum / g.length).toFixed(1), noise: +(lap / c).toFixed(2) };
    if (camBase) {
      const tag = light.luma < LIGHT_LUMA_DIM ? 'DIM' : 'OK';
      elCamInfo.textContent = `${camBase} · LIGHT ${light.luma} ${tag}`;
    }
  } catch (_) { /* frame not ready */ }
}
setInterval(sampleLight, 500);

// localStorage, NOT a cookie. This app never talks to a server, so a cookie
// would be transmitted on every request for no benefit and capped at ~4KB.
// localStorage is per-origin, survives closing the app, and works offline.
//
// ⚠️ `facing` is the user's INTENT and is what gets persisted. The device's
// reported facingMode is kept separately in `liveFacing`. Previously the
// report overwrote `facing` (old line 435), which meant any phone that
// misreports facingMode left the FLIP button toggling off a polluted value —
// so a flip could silently no-op. Intent must never be written by the device.
const PREF_KEY = 'titan_pose_prefs_v1';
function loadPrefs(){
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(patch){
  try { localStorage.setItem(PREF_KEY, JSON.stringify(Object.assign(loadPrefs(), patch))); } catch {}
}
const prefs = loadPrefs();
let facing = (prefs.facing === 'user' || prefs.facing === 'environment') ? prefs.facing : 'environment';
let liveFacing = facing;          // what the DEVICE actually gave us, for the label only
let voiceOn = prefs.voiceOn !== false;
let lastCueSpoken = '', lastCueAt = 0, lastSpeakAt = 0, readySpoken = false, outFrameAt = 0;

// ── camera roll (phone not level) ────────────────────────────────────────
// A phone that is off-level by g degrees rotates the whole body in the image.
// shoulderTilt then reads a tilt that belongs to the PHONE, not the athlete —
// at 3 deg roll that is 3 deg of false shoulder tilt against a +/-3 deg band,
// i.e. permanently red and un-passable. Kevin called this on 2026-10-22.
const DEROL_MAX  = 6;   // auto-correct roll up to this many degrees
const LEVEL_WARN = 3;   // above this, tell him to physically fix the phone
const CENTRE_SOFT = 0.10;  // start telling him he has drifted off centre
const CENTRE_HARD = 0.18;  // badly off — say it over anything else

let rollDeg = 0, levelReady = false;

function initLevel() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  const attach = () => {
    window.addEventListener('deviceorientation', e => {
      if (e.gamma == null || !Number.isFinite(e.gamma)) return;
      rollDeg = e.gamma; levelReady = true;
    }, { passive: true });
  };
  // iOS 13+ needs an explicit gesture-bound permission
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(p => { if (p === 'granted') attach(); }).catch(() => {});
  } else attach();
}

// Un-rotate the body so it is judged as if the phone were perfectly level.
// Rotation happens in ISOTROPIC space (x scaled to the same pixel units as y),
// otherwise the aspect ratio distorts the rotation itself.
function deroll(lm) {
  if (!levelReady || Math.abs(rollDeg) < 0.2) return lm;
  const deg = Math.max(-DEROL_MAX, Math.min(DEROL_MAX, rollDeg));
  const th = deg * Math.PI / 180;              // ⚠ sign field-verified below
  const c = Math.cos(th), s = Math.sin(th);
  const A = (video.videoWidth || 1) / (video.videoHeight || 1);
  return lm.map(p => {
    const X = (p.x - 0.5) * A, Y = p.y - 0.5;
    return { ...p, x: 0.5 + (X * c - Y * s) / A, y: 0.5 + (X * s + Y * c) };
  });
}

// Shoulder tilt and every asymmetry check are judged on an UN-ROLLED body, so a
// phone that is slightly off-level stops telling him to drop a shoulder that is
// already level. Shows the live roll so he can fix the phone if it is far out.
function updateLevelUI() {
  const el = $('levelInfo');
  if (!el) return;
  if (!levelReady) { el.textContent = 'LEVEL — unavailable'; el.className = 'levelInfo off'; return; }
  const d = Math.abs(rollDeg);
  const cls = d <= 1 ? 'ok' : d <= LEVEL_WARN ? 'warn' : 'bad';
  const state = d <= 1 ? 'LEVEL' : d <= LEVEL_WARN ? 'AUTO-LEVELLING' : 'PHONE TILTED — FIX IT';
  const shown = levelReady ? `${rollDeg >= 0 ? '+' : ''}${rollDeg.toFixed(1)}°` : '';
  el.textContent = `${state} · ${shown}`;
  el.className = 'levelInfo ' + cls;
}

// Kevin, 2026-10-23: *"staying centered on the frame helped. Maybe add that to
// the audio instructions if I drift left or right of frame."*
// ⚠️ DIRECTION IS ANATOMICAL, NOT SCREEN-SIDE. A rear camera pointed at his back
// has his left on the image's left; a FRONT camera facing him puts his left on
// the image's RIGHT. And in a back pose he cannot see the screen at all — so the
// cue must name HIS left or right, never "screen left".
function centreCue(m) {
  if (!Number.isFinite(m.centreX)) return null;
  const off = m.centreX - 0.5;
  if (Math.abs(off) < CENTRE_SOFT) return null;
  const towardImageRight = off < 0;
  const hisRight = (facing === 'user') ? !towardImageRight : towardImageRight;
  const dir = hisRight ? 'right' : 'left';
  return {
    text:  `You are off centre — step to your ${dir}`,
    short: `OFF CENTRE — STEP ${dir.toUpperCase()}`,
    hard:  Math.abs(off) >= CENTRE_HARD,
  };
}

// ── geometry ─────────────────────────────────────────────────────────────
const angle = (a, b, c) => {
  const v1 = [a.x - b.x, a.y - b.y], v2 = [c.x - b.x, c.y - b.y];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  if (!d) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, (v1[0]*v2[0] + v1[1]*v2[1]) / d))) * 180 / Math.PI;
};

// ⚠️⚠️ THE ISOTROPY FIX — this was a real bug, found 2026-10-22.
// Landmark x and y are BOTH normalised 0..1, but the frame is W x H pixels: one
// unit of x is W px, one unit of y is H px. Any angle, or any x-over-y ratio,
// computed straight from those numbers is therefore WRONG — and wrong by an
// amount that depends on the aspect ratio AND on which way the limb points.
// On a 1080x1440 portrait frame a true 110 deg elbow measured 64.1 deg, which is
// exactly the kind of nonsense that made "elbows level" un-passable.
// ⇒ Scale x into the same units as y before measuring anything.
//   RATIOS OF y TO y (elbowAbove) were already safe; RATIOS OF x TO y (spanTorso)
//   were not, and every ANGLE was unsafe.
function measure(lm) {
  const A = (video.videoWidth || 1) / (video.videoHeight || 1);
  const P = i => ({ x: lm[i].x * A, y: lm[i].y, visibility: lm[i].visibility });
  const shY = (P(L.LSH).y + P(L.RSH).y) / 2;
  const hipY = (P(L.LHIP).y + P(L.RHIP).y) / 2;
  const elY = (P(L.LEL).y + P(L.REL).y) / 2;
  const torso = Math.abs(hipY - shY);
  const lEl = angle(P(L.LSH), P(L.LEL), P(L.LWR));
  const rEl = angle(P(L.RSH), P(L.REL), P(L.RWR));
  const span = Math.abs(P(L.RSH).x - P(L.LSH).x);
  return {
    torso,
    elbowAbove: torso > 1e-4 ? (shY - elY) / torso : NaN,
    spanTorso:  torso > 1e-4 ? span / torso : NaN,
    // Horizontal framing. RAW image x (not aspect-scaled) because this is about
    // where he sits in the frame, not about geometry.
    centreX: (lm[L.LSH].x + lm[L.RSH].x + lm[L.LHIP].x + lm[L.RHIP].x) / 4,
    elbowAngle: (lEl + rEl) / 2,
    elbowAsym:  Math.abs(lEl - rEl),
    shoulderTilt: Math.atan2(P(L.RSH).y - P(L.LSH).y, Math.abs(P(L.RSH).x - P(L.LSH).x)) * 180 / Math.PI,
    lElbowY: P(L.LEL).y, rElbowY: P(L.REL).y,
    vis: Math.min(P(L.LSH).visibility, P(L.RSH).visibility, P(L.LHIP).visibility, P(L.RHIP).visibility),
  };
}

// ── temporal smoothing ───────────────────────────────────────────────────
// ⚠️ THE POSE LANDMARKER IS NOISY FRAME TO FRAME. A single-frame tolerance is
// not a tolerance on the ATHLETE, it is a tolerance on the MODEL. With +/-4 deg
// on the symmetry gate, landmark jitter alone can flip green/red several times
// a second — the athlete then chases a target that is moving without them.
// ⇒ Median of the last SMOOTH_N frames. Median, not mean: one wild frame cannot
//   drag the value, so a single bad landmark read is simply ignored.
const SMOOTH_N = 9;
let mbuf = [];

function resetSmooth() { mbuf = []; }

function smooth(m) {
  mbuf.push(m);
  if (mbuf.length > SMOOTH_N) mbuf.shift();
  const out = {};
  for (const k in m) {
    const vals = mbuf.map(x => x[k]).filter(Number.isFinite).sort((a, b) => a - b);
    out[k] = vals.length ? vals[vals.length >> 1] : m[k];
  }
  return out;
}

// ── gate evaluation ──────────────────────────────────────────────────────
// HYSTERESIS: once a gate goes green it STAYS green until the value leaves the
// band by HYST_FRAC of the band width. A gate that flickers at the boundary can
// never accumulate the 10 s hold, which is exactly the "never could lock"
// symptom on Back Double Biceps (2026-10-22).
const HYST_FRAC = 0.15;
const gatePrev = {};

function resetGates() { for (const k in gatePrev) delete gatePrev[k]; }

function evaluate(pose, m) {
  return pose.gates.map(g => {
    if (g.measure === 'manual')
      return { ...g, value: null, pass: manualTicked[g.id] !== false, manual: true };
    const v = m[g.measure];
    let ok = false;
    if (Number.isFinite(v)) {
      const span = (g.max - g.min) || 1;
      const h = span * HYST_FRAC;
      ok = (gatePrev[g.id] === true)
        ? (v >= g.min - h && v <= g.max + h)     // sticky while green
        : (v >= g.min && v <= g.max);            // must be clean to enter
    }
    gatePrev[g.id] = ok;
    // ⚠️ ADVISORY — reported and spoken, but does NOT block the lock.
    // elbowAngle was measured in anisotropic (normalised x,y) space until
    // 2026-10-23, so every band on it was derived from a wrong number. Those
    // bands are invalid until re-derived from real post-fix data; until then
    // this gate gives information instead of holding the athlete hostage.
    const advisory = !!g.advisory || g.measure === 'elbowAngle';
    return { ...g, value: v, pass: ok, advisory };
  });
}

// The cue to show: the WORST failure wins, one line only.
function pickCue(gates, m) {
  const fails = gates.filter(g => !g.pass && !g.manual);
  if (!fails.length) return null;
  // ⚠️ CUE-CONFLICT FIX (Kevin, 2026-10-23): *"kept telling me to raise my left
  // elbow until they were not parallel, then it would complain my shoulder was
  // not level."* Raising an elbow ELEVATES that shoulder, so fixing symmetry
  // breaks shoulder_level — and dropping the shoulder drops the elbow, breaking
  // symmetry again. The two chase each other and the pose never locks.
  // ⇒ The SHOULDER LINE IS THE BASE. Fix it first; elbow height follows from
  //   scapular position anyway. One instruction instead of two fighting ones.
  const g = fails.find(x => x.id === 'shoulder_level') || fails[0];
  if (g.sideAware) {
    // name the side that is physically LOWER (bigger y)
    const side = m.lElbowY > m.rElbowY ? 'left' : 'right';
    return (g.cueHigh || '').replace('{side}', side);
  }
  const v = g.value;
  if (Number.isFinite(v) && Number.isFinite(g.min) && v < g.min) return g.cueLow || g.label;
  if (Number.isFinite(v) && Number.isFinite(g.max) && v > g.max) return g.cueHigh || g.label;
  return g.label;
}

// ── voice ────────────────────────────────────────────────────────────────
const speechOK = typeof window !== 'undefined' && 'speechSynthesis' in window;

function speak(text, interrupt = true) {
  if (!voiceOn || !speechOK || !text) return;
  try {
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.pitch = 1.0; u.volume = 1.0;
    speechSynthesis.speak(u);
  } catch (_) { /* speech is a nicety, never fatal */ }
}

function announcePose(p) {
  // Label first, then the cues. This is the ONLY instruction he gets for a
  // back pose, so it is not optional.
  speak(`${p.label}. ${p.cues.join('. ')}.`);
}

function maybeSpeakCue(cue, now) {
  if (!cue) return;
  // ⚠️ HARD FLOOR BETWEEN ANY TWO UTTERANCES.
  // The symmetry cue names a side, so when the athlete rocks between the two
  // elbows the TEXT alternates — and `cue !== lastCueSpoken` is then true every
  // frame, which defeated the repeat throttle entirely and queued a continuous
  // stream of speech. The floor is what actually stops the chatter.
  if (now - lastSpeakAt < SPEAK_MIN_GAP) return;
  if (cue === lastCueSpoken && now - lastCueAt < CUE_REPEAT_MS) return;
  lastCueSpoken = cue; lastCueAt = now; lastSpeakAt = now;
  speak(cue);
}

// ── drawing ──────────────────────────────────────────────────────────────
const CONN = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(lm, gates) {
  const w = overlay.width, h = overlay.height;
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const bad = new Set();
  gates.forEach(g => {
    if (g.pass || g.manual) return;
    if (g.id === 'elbow_height' || g.id === 'elbow_high' || g.id === 'elbow_below' ||
        g.id === 'elbow_angle') { bad.add(L.LEL); bad.add(L.REL); }
    if (g.id === 'symmetry') { bad.add(L.LEL); bad.add(L.REL); }
    if (g.id === 'shoulder_level') { bad.add(L.LSH); bad.add(L.RSH); }
    if (g.id === 'side_on') { bad.add(L.LSH); bad.add(L.RSH); }
  });
  ctx.lineWidth = Math.max(2, w / 240);
  CONN.forEach(([a, b]) => {
    ctx.strokeStyle = (bad.has(a) || bad.has(b)) ? '#ff3b3b' : 'rgba(60,255,140,.85)';
    ctx.beginPath(); ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h); ctx.stroke();
  });
  [L.LSH, L.RSH, L.LEL, L.REL, L.LWR, L.RWR, L.LHIP, L.RHIP, L.LKN, L.RKN].forEach(i => {
    ctx.fillStyle = bad.has(i) ? '#ff3b3b' : '#3cff8c';
    ctx.beginPath(); ctx.arc(lm[i].x * w, lm[i].y * h, Math.max(3, w / 150), 0, 7); ctx.fill();
  });
}

// ── session control ──────────────────────────────────────────────────────
const manualTicked = {};
const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [x[i], x[j]] = [x[j], x[i]]; } return x; };

// FIX 4 — a FRONT pose always opens the session so he can confirm framing
// before he turns his back to the camera. The rest are still shuffled.
function buildOrder() {
  const front = GATES.POSES.filter(p => p.facing === 'FRONT').sort((a, b) => a.order - b.order);
  const opener = front[0] || GATES.POSES[0];
  return [opener, ...shuffle(GATES.POSES.filter(p => p !== opener))];
}

function startSession() {
  order = buildOrder();
  idx = 0; state = 'pose';
  t0 = performance.now();
  session = { session: { date: new Date().toISOString(),
                         app: 'titan-pose v' + (window.APP_VERSION || 'unknown'),
                         started_at: new Date().toISOString(),
                         camera: facing,
                         resolution: `${video.videoWidth}x${video.videoHeight}`,
                         order: order.map(p => p.id) }, poses: [] };
  elStart.disabled = true; elStop.disabled = false; elSummary.textContent = '';
  elPrev.disabled = false; elNext.disabled = false;
  loadPose();
}

function loadPose() {
  if (idx >= order.length) return finishSession();
  const p = order[idx];
  greenRunStart = 0; holdAccum = 0; lastTick = performance.now();
  lastCueSpoken = ''; readySpoken = false; outFrameAt = 0; lastSpeakAt = 0;
  resetSmooth(); resetGates();
  elPose.textContent = p.label;
  elCue.textContent = p.cues.join(' · ');
  elCue.className = 'cue';
  elTimer.textContent = '0.0';
  elReady.textContent = 'GET INTO POSITION'; elReady.className = 'ready wait';
  elCount.textContent = `${idx + 1} / ${order.length}`;
  elProgress.style.width = `${(idx / order.length) * 100}%`;
  elGateList.innerHTML = p.gates.map(g =>
    `<li data-g="${g.id}"><span class="dot"></span>${g.label}` +
    `<em class="${g.status}">${g.status === 'manual' ? 'you judge' : g.status}</em></li>`).join('');
  currentRecord = { pose: p.id, label: p.label, facing: p.facing,
                    hold_seconds: 0, attempts: 1, skipped: false, gates: [],
                    // ── v1.8 timing: the two metrics that show FLAWLESS FLOW ──
                    // t_start  : when this pose was put on screen
                    // t_green  : first frame where EVERY gate passed
                    // set_seconds      = t_green - t_start   "how fast I got in the window"
                    // transition_seconds = t_start - previous t_end   "how fast I reset"
                    t_start: Math.round(performance.now() - t0),
                    t_green: null, t_end: null,
                    set_seconds: null, transition_seconds: null };
  announcePose(p);
}

// Commit the pose in progress. Partial holds are kept — a skipped pose still
// carries information for calibration.
function commitCurrent(skipped, advance) {
  if (!session || !currentRecord) { currentRecord = null; return; }
  // ⚠️ ALWAYS COMMIT (2026-10-23). A pose he fought with and lost is the most
  // valuable calibration data in the session. Discarding anything under 0.3 s of
  // hold is why back_double_biceps left no trace at all on 2026-10-23 — the one
  // pose that was actually broken. Incomplete poses now carry incomplete:true
  // with hold_seconds 0 instead of vanishing.
  {
    currentRecord.hold_seconds = +(holdAccum / 1000).toFixed(2);
    currentRecord.skipped = !!skipped;
    currentRecord.incomplete = holdAccum <= 300;
    // Camera roll at commit time. Four front poses on 2026-10-23 read
    // shoulder_level between -2.06 and -2.71 — a consistent one-direction bias
    // that smells like phone tilt rather than anatomy. Without the roll in the
    // export those two causes are indistinguishable.
    currentRecord.roll_deg = levelReady ? +rollDeg.toFixed(1) : null;
    currentRecord.level_active = !!levelReady;
    // WHY THIS FIELD EXISTS (v1.8.1):
    // transition_seconds is only meaningful when the ATHLETE drives the change.
    //  - 'auto'   : finishPose() advances via setTimeout(loadPose, 700), so the
    //               gap is a near-constant ~0.70s. That measures the app.
    //  - 'manual' : next/prev call loadPose() immediately, so the gap is real
    //               time the athlete took to reset. That measures the athlete.
    // Without this label the two are indistinguishable in the history and any
    // trend on transition_seconds would be meaningless.
    currentRecord.advance = advance || 'auto';
    // Light at commit time. Recorded so v2.0's PROGRESS tab can flag sessions
    // shot in poor light — a dim/noisy session has unreliable set_seconds and
    // must NOT be compared against a clean one.
    currentRecord.light = (light.luma != null) ? { luma: light.luma, noise: light.noise } : null;
    currentRecord.t_end = Math.round(performance.now() - t0);
    // set-time: how long it took to find the pose window
    if (Number.isFinite(currentRecord.t_start) && Number.isFinite(currentRecord.t_green)) {
      currentRecord.set_seconds = +((currentRecord.t_green - currentRecord.t_start) / 1000).toFixed(2);
    }
    // transition-time: the gap from the PREVIOUS pose locking to this one starting
    const prev = session.poses[session.poses.length - 1];
    if (prev && Number.isFinite(prev.t_end) && Number.isFinite(currentRecord.t_start)) {
      currentRecord.transition_seconds = +((currentRecord.t_start - prev.t_end) / 1000).toFixed(2);
    }
    session.poses.push(currentRecord);
  }
  currentRecord = null;
}

function finishPose() {
  commitCurrent(false, 'auto');
  state = 'pose'; idx++;
  setTimeout(loadPose, 700);
}

// FIX 2 — manual navigation, works at any time during a pose.
function nextPose() {
  if (!session) return;
  commitCurrent(true, 'manual');
  if (idx + 1 >= order.length) return finishSession();
  idx++; loadPose();
}

function prevPose() {
  if (!session) return;
  commitCurrent(true, 'manual');
  if (idx > 0) idx--;          // at the first pose, just restart it
  loadPose();
}

function finishSession() {
  state = 'done';
  commitCurrent(true, 'end');
  stopCamera();
  elReady.textContent = 'SESSION COMPLETE'; elReady.className = 'ready ok';
  elPose.textContent = 'Done'; elCue.textContent = '';
  elProgress.style.width = '100%';
  elExport.disabled = false;
  elPrev.disabled = true; elNext.disabled = true;
  elSummary.textContent = summaryText();
  speak('Session complete.');
}

// ── main loop ────────────────────────────────────────────────────────────
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2) return;
  syncOverlay();
  updateLevelUI();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  const now = performance.now();
  const dt = Math.min(200, now - lastTick); lastTick = now;
  const lm = res.landmarks && res.landmarks[0];

  if (state !== 'pose') { draw(lm, []); return; }

  if (!lm) {
    // FIX 3 — he cannot see the screen in a back pose. Tell him.
    draw(lm, []);
    elReady.textContent = 'STEP INTO FRAME'; elReady.className = 'ready wait';
    if (now - outFrameAt > OUT_OF_FRAME_MS) { outFrameAt = now; speak('Step into frame.'); }
    return;
  }

  const pose = order[idx];
  // ORDER MATTERS: un-roll the body -> measure in isotropic space -> median smooth.
  const m = smooth(measure(deroll(lm)));
  const gates = evaluate(pose, m);

  // per-gate UI
  gates.forEach(g => {
    const li = elGateList.querySelector(`[data-g="${g.id}"]`);
    if (li) li.className = g.pass ? 'ok' : (g.advisory ? 'adv' : 'bad');
  });

  const allGreen = gates.every(g => g.pass || g.advisory) && m.vis > 0.5;

  if (!allGreen) {
    greenRunStart = 0;
    readySpoken = false;
    const cc = centreCue(m);
    const cue = cc ? cc.text : pickCue(gates, m);
    if (cue) { elCue.textContent = cc ? cc.short : cue; elCue.className = 'cue bad'; }
    // Disambiguate WHY he isn't being seen. The landmarker failing is the real
    // signal; luma only breaks the tie between "wrong place" and "wrong room".
    if (m.vis > 0.5) {
      elReady.textContent = 'NOT YET';
    } else if (light.luma != null && light.luma < LIGHT_LUMA_DIM) {
      elReady.textContent = `TOO DARK (${Math.round(light.luma)}) — ADD LIGHT`;
    } else {
      elReady.textContent = 'STEP INTO FRAME';
    }
    elReady.className = 'ready wait';
    maybeSpeakCue(cue, now);
    // hold clock PAUSES, does not reset
  } else {
    if (!greenRunStart) {
      greenRunStart = now;
      // v1.8 — stamp the FIRST all-green frame of this pose. This is the
      // "how quickly did I find the window" metric; it is per-session-t0.
      if (currentRecord && currentRecord.t_green == null) {
        currentRecord.t_green = Math.round(performance.now() - t0);
      }
    }
    const greenFor = now - greenRunStart;
    if (greenFor >= READY_MS) {
      holdAccum += dt;
      elReady.textContent = 'READY — HOLD'; elReady.className = 'ready ok';
      elCue.textContent = pose.cues.join(' · '); elCue.className = 'cue';
      if (!readySpoken) { readySpoken = true; lastCueSpoken = ''; speak('Good. Hold.'); }
    } else {
      elReady.textContent = 'HOLD STILL…'; elReady.className = 'ready wait';
    }
  }

  elTimer.textContent = (holdAccum / 1000).toFixed(1);
  currentRecord.gates = gates.map(g => ({
    name: g.id, pass: !!g.pass,
    value: Number.isFinite(g.value) ? +g.value.toFixed(3) : null,
    target: g.manual ? 'manual' : `[${g.min}, ${g.max}]`,
    status: g.status,
  }));

  draw(lm, gates);

  if (holdAccum >= HOLD_MS) {
    elReady.textContent = 'POSE LOCKED ✓'; elReady.className = 'ready ok';
    elCue.textContent = '';
    speak('Locked.');
    holdAccum = HOLD_MS;      // stop the clock ticking past the target
    finishPose();
  }
}

// ── camera + model ───────────────────────────────────────────────────────
function setCamLabel() {
  elFlip.textContent = facing === 'user' ? 'CAM: FRONT' : 'CAM: REAR';
}

// Keep the overlay canvas exactly the size of the video. Called every frame
// because a camera flip, a rotation, or a late metadata event can change the
// video dimensions under us.
function syncOverlay() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return false;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  return true;
}

async function attachStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());

  // ⚠️ 16:9 IS A CROP OF THE NATIVE 4:3 SENSOR.
  // Almost every phone camera reads out 4:3; asking for 16:9 (was 1280x720)
  // discards the top and bottom of the frame. For a head-to-toe pose that is
  // exactly the wrong axis to throw away — it is why the athlete has to stand
  // further back than the room requires.
  // ⇒ Request 4:3 at high resolution, then fall back gracefully if the device
  //    will not honour it.
  const base = { facingMode: { ideal: facing } };
  const tries = [
    { ...base, width: { ideal: 1440 }, height: { ideal: 1080 }, aspectRatio: { ideal: 4 / 3 } },
    { ...base, width: { ideal: 1440 }, height: { ideal: 1080 } },
    { ...base },
  ];
  let lastErr = null;
  for (const v of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); break; }
    catch (e) { lastErr = e; }
  }
  if (!stream) throw lastErr || new Error('no camera');

  video.srcObject = stream;
  // ⚠️ WAIT FOR REAL DIMENSIONS. On a camera FLIP the element briefly reports
  // 0x0, and sizing the overlay from that leaves the canvas at 2x2 — the
  // skeleton then draws into a two-pixel box and the whole view goes dead.
  // This is exactly what the first v1.2 build did.
  await new Promise(res => {
    if (video.videoWidth) return res();
    const done = () => { video.removeEventListener('loadedmetadata', done); res(); };
    video.addEventListener('loadedmetadata', done);
    setTimeout(res, 1500);
  });
  try { await video.play(); } catch (_) { /* autoplay race, loop will retry */ }
  syncOverlay();
  lastVideoTime = -1;

  // Report what the device ACTUALLY gave us — camera, resolution and shape.
  // If a phone hands back a 16:9 crop despite the 4:3 request, this shows it.
  const tr = stream.getVideoTracks()[0];
  const st = (tr && tr.getSettings && tr.getSettings()) || {};
  if (st.facingMode) liveFacing = st.facingMode;   // label only — never write intent
  const w = st.width || video.videoWidth, h = st.height || video.videoHeight;
  // Orientation-independent shape label. A phone commonly returns the 4:3
  // request ROTATED (Kevin got 1080x1440 on 2026-10-22) — that is 3:4 PORTRAIT
  // and is the ideal full-body frame, so it must not read as "0.75".
  const long = Math.max(w, h), short = Math.min(w, h);
  const ar = short ? long / short : 0;
  const shape = Math.abs(ar - 4 / 3) < 0.08 ? '4:3'
              : Math.abs(ar - 16 / 9) < 0.08 ? '16:9'
              : Math.abs(ar - 3 / 2) < 0.08 ? '3:2'
              : (w && h ? (long / short).toFixed(2) : '?');
  const orient = h > w ? 'PORTRAIT' : 'LANDSCAPE';
  camBase = `${liveFacing === 'user' ? 'FRONT' : 'REAR'} · ${w}×${h} · ${shape} ${orient}`;
  elCamInfo.textContent = camBase;   // the light sampler appends "· LIGHT <luma> OK|DIM"
  setCamLabel();
}

async function startCamera() {
  elStart.disabled = true; elStart.textContent = 'STARTING…';
  await attachStream();

  if (!landmarker) {
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
    });
  }
  running = true; elStart.textContent = 'RUNNING'; elStart.disabled = true;
  elFlip.disabled = false;
  loop();
}

// FIX 1 — swap front/rear without tearing down the session or losing the hold.
async function flipCamera() {
  if (!stream) return;
  facing = facing === 'environment' ? 'user' : 'environment';
  setCamLabel();
  elFlip.disabled = true;
  try {
    await attachStream();
  } catch (e) {
    // the requested camera is unavailable — fall back and say so
    facing = facing === 'environment' ? 'user' : 'environment';
    setCamLabel();
    try { await attachStream(); } catch (_) { console.error(e); }
  } finally {
    elFlip.disabled = !running || !stream;
    savePrefs({ facing });        // remember the choice — survives closing the app
  }
}

function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  elStop.disabled = true; elFlip.disabled = true;
  elStart.disabled = false; elStart.textContent = 'START SESSION';
  if (speechOK) speechSynthesis.cancel();
}

function stopSession() {
  // ⚠️ COMMIT BEFORE TEARING DOWN. The pose he stops on is almost always the one
  // he was losing to — on 2026-10-23 that was back_double_biceps, and it left
  // the export with no data at all.
  if (session) commitCurrent(true);
  stopCamera(); state = 'idle';
  elReady.textContent = 'STOPPED'; elReady.className = 'ready wait';
  elPrev.disabled = true; elNext.disabled = true;
  elProgress.style.width = '0%';
  if (session && session.poses.length) {
    elExport.disabled = false;
    // ⚠️ Show the summary on STOP too. It used to only be built by
    // finishSession(), so stopping early left SAVE enabled with a blank panel —
    // he could export a session he could not read.
    elSummary.textContent = summaryText();
  }
}

// ── export ───────────────────────────────────────────────────────────────
function summaryText() {
  if (!session) return '';
  const lines = [`TITAN POSE — ${session.session.date.slice(0, 10)}`,
                 `camera: ${session.session.camera}`];
  let pass = 0, total = 0;
  session.poses.forEach(p => {
    const g = p.gates.filter(x => x.target !== 'manual');
    const pg = g.filter(x => x.pass).length;
    pass += pg; total += g.length;
    lines.push(`${p.label}${p.skipped ? ' (skipped)' : ''}: held ${p.hold_seconds}s · ${pg}/${g.length} gates` +
      (p.set_seconds != null ? ` · set ${p.set_seconds}s` : '') +
      (p.transition_seconds != null
        ? ` · reset ${p.transition_seconds}s${p.advance && p.advance !== 'auto' ? ' (' + p.advance + ')' : ' (auto)'}`
        : ''));
    g.filter(x => !x.pass).forEach(x => lines.push(`   ✗ ${x.name} = ${x.value} (target ${x.target})`));
  });
  lines.push(`TOTAL: ${pass}/${total} gates passed`);
  return lines.join('\n');
}

async function exportSession() {
  const json = JSON.stringify(session, null, 2);
  const name = `titan-pose_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Titan Pose session' }); return; } catch (e) {}
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
}

// ── wire up ──────────────────────────────────────────────────────────────
elStart.addEventListener('click', async () => {
  try {
    if (speechOK) speechSynthesis.getVoices();   // warm the voice list on the gesture
    initLevel();                                  // needs this same gesture on iOS
    await startCamera();
    startSession();
  } catch (e) {
    elStart.disabled = false; elStart.textContent = 'START SESSION';
    elReady.textContent = 'CAMERA/MODEL FAILED — see console'; console.error(e);
  }
});
elStop.addEventListener('click', stopSession);
elFlip.addEventListener('click', flipCamera);
elPrev.addEventListener('click', prevPose);
elNext.addEventListener('click', nextPose);
elVoice.addEventListener('click', () => {
  voiceOn = !voiceOn;
  elVoice.textContent = voiceOn ? 'VOICE: ON' : 'VOICE: OFF';
  savePrefs({ voiceOn });
  if (speechOK) speechSynthesis.cancel();
  if (voiceOn) speak('Voice on.');
});
elExport.addEventListener('click', exportSession);
elCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(elSummary.textContent); elCopy.textContent = 'COPIED'; }
  catch { elCopy.textContent = 'select + copy manually'; }
  setTimeout(() => elCopy.textContent = 'Copy summary', 1500);
});
elExport.disabled = true;
elVoice.textContent = voiceOn ? 'VOICE: ON' : 'VOICE: OFF';   // reflect the SAVED state
setCamLabel();
