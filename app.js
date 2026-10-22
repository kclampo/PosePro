/* app.js — TITAN POSE v1.3 — real-time posing gate trainer
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

let facing = 'environment';   // 'environment' = rear, 'user' = front
let voiceOn = true;
let lastCueSpoken = '', lastCueAt = 0, lastSpeakAt = 0, readySpoken = false, outFrameAt = 0;

// ── geometry ─────────────────────────────────────────────────────────────
const angle = (a, b, c) => {
  const v1 = [a.x - b.x, a.y - b.y], v2 = [c.x - b.x, c.y - b.y];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  if (!d) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, (v1[0]*v2[0] + v1[1]*v2[1]) / d))) * 180 / Math.PI;
};

function measure(lm) {
  const P = i => lm[i];
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
    return { ...g, value: v, pass: ok };
  });
}

// The cue to show: the WORST failure wins, one line only.
function pickCue(gates, m) {
  const fails = gates.filter(g => !g.pass && !g.manual);
  if (!fails.length) return null;
  const g = fails[0];
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
  session = { session: { date: new Date().toISOString(), app: 'titan-pose v1.3',
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
                    hold_seconds: 0, attempts: 1, skipped: false, gates: [] };
  announcePose(p);
}

// Commit the pose in progress. Partial holds are kept — a skipped pose still
// carries information for calibration.
function commitCurrent(skipped) {
  if (!session || !currentRecord) { currentRecord = null; return; }
  if (holdAccum > 300) {
    currentRecord.hold_seconds = +(holdAccum / 1000).toFixed(2);
    currentRecord.skipped = !!skipped;
    session.poses.push(currentRecord);
  }
  currentRecord = null;
}

function finishPose() {
  commitCurrent(false);
  state = 'pose'; idx++;
  setTimeout(loadPose, 700);
}

// FIX 2 — manual navigation, works at any time during a pose.
function nextPose() {
  if (!session) return;
  commitCurrent(true);
  if (idx + 1 >= order.length) return finishSession();
  idx++; loadPose();
}

function prevPose() {
  if (!session) return;
  commitCurrent(true);
  if (idx > 0) idx--;          // at the first pose, just restart it
  loadPose();
}

function finishSession() {
  state = 'done';
  commitCurrent(true);
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
  const m = smooth(measure(lm));   // median-smoothed: see the smoothing block
  const gates = evaluate(pose, m);

  // per-gate UI
  gates.forEach(g => {
    const li = elGateList.querySelector(`[data-g="${g.id}"]`);
    if (li) li.className = g.pass ? 'ok' : 'bad';
  });

  const allGreen = gates.every(g => g.pass) && m.vis > 0.5;

  if (!allGreen) {
    greenRunStart = 0;
    readySpoken = false;
    const cue = pickCue(gates, m);
    if (cue) { elCue.textContent = cue; elCue.className = 'cue bad'; }
    elReady.textContent = m.vis > 0.5 ? 'NOT YET' : 'STEP INTO FRAME';
    elReady.className = 'ready wait';
    maybeSpeakCue(cue, now);
    // hold clock PAUSES, does not reset
  } else {
    if (!greenRunStart) greenRunStart = now;
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
  if (st.facingMode) facing = st.facingMode;
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
  elCamInfo.textContent =
    `${facing === 'user' ? 'FRONT' : 'REAR'} · ${w}×${h} · ${shape} ${orient}`;
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
  stopCamera(); state = 'idle';
  elReady.textContent = 'STOPPED'; elReady.className = 'ready wait';
  elPrev.disabled = true; elNext.disabled = true;
  elProgress.style.width = '0%';
  if (session && session.poses.length) elExport.disabled = false;
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
    lines.push(`${p.label}${p.skipped ? ' (skipped)' : ''}: held ${p.hold_seconds}s · ${pg}/${g.length} gates`);
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
setCamLabel();
