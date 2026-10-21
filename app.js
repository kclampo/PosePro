/* app.js — TITAN POSE — real-time posing gate trainer
 *
 * Runs 100% on-device. No network calls after load. No credentials.
 * MediaPipe Pose Landmarker (WASM/GPU) -> body-relative measurements -> gates -> green/red.
 *
 * DESIGN RULE: the screen never shows a raw number to the athlete.
 * It colours the joint and prints ONE plain-language cue.
 * Numbers appear only in the export, for the coach.
 */

import { PoseLandmarker, FilesetResolver, DrawingUtils }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

const HOLD_MS = 10_000;      // required green hold
const READY_MS = 800;        // must be green this long before the hold clock starts

// ── landmarks ────────────────────────────────────────────────────────────
const L = { NOSE:0, LEAR:7, REAR:8, LSH:11, RSH:12, LEL:13, REL:14, LWR:15, RWR:16,
            LHIP:23, RHIP:24, LKN:25, RKN:26, LAN:27, RAN:28 };

// ── dom ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const video = $('cam'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const elPose = $('poseName'), elCue = $('cue'), elTimer = $('timer'),
      elReady = $('ready'), elProgress = $('progress'), elCount = $('poseCount'),
      elGateList = $('gateList'), elStart = $('startBtn'), elStop = $('stopBtn'),
      elExport = $('exportBtn'), elSummary = $('summary'), elCopy = $('copyBtn');

let landmarker = null, stream = null, running = false, lastVideoTime = -1;
let order = [], idx = 0, state = 'idle';
let greenRunStart = 0, holdAccum = 0, lastTick = 0;
let session = null, currentRecord = null;

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

// ── gate evaluation ──────────────────────────────────────────────────────
function evaluate(pose, m) {
  return pose.gates.map(g => {
    if (g.measure === 'manual')
      return { ...g, value: null, pass: manualTicked[g.id] !== false, manual: true };
    const v = m[g.measure];
    const ok = Number.isFinite(v) && v >= g.min && v <= g.max;
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

function startSession() {
  order = shuffle(GATES.POSES);
  idx = 0; state = 'pose';
  session = { session: { date: new Date().toISOString(), app: 'titan-pose v1.0',
                         order: order.map(p => p.id) }, poses: [] };
  elStart.disabled = true; elStop.disabled = false; elSummary.textContent = '';
  loadPose();
}

function loadPose() {
  if (idx >= order.length) return finishSession();
  const p = order[idx];
  greenRunStart = 0; holdAccum = 0; lastTick = performance.now();
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
  currentRecord = { pose: p.id, label: p.label, hold_seconds: 0, attempts: 1, gates: [] };
}

function finishPose() {
  currentRecord.hold_seconds = +(holdAccum / 1000).toFixed(2);
  session.poses.push(currentRecord);
  state = 'pose'; idx++; setTimeout(loadPose, 600);
}

function finishSession() {
  state = 'done';
  stopCamera();
  elReady.textContent = 'SESSION COMPLETE'; elReady.className = 'ready ok';
  elPose.textContent = 'Done'; elCue.textContent = '';
  elProgress.style.width = '100%';
  elExport.disabled = false;
  elSummary.textContent = summaryText();
}

// ── main loop ────────────────────────────────────────────────────────────
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  const now = performance.now();
  const dt = Math.min(200, now - lastTick); lastTick = now;
  const lm = res.landmarks && res.landmarks[0];

  if (state !== 'pose' || !lm) { draw(lm, []); return; }

  const pose = order[idx];
  const m = measure(lm);
  const gates = evaluate(pose, m);

  // per-gate UI
  gates.forEach(g => {
    const li = elGateList.querySelector(`[data-g="${g.id}"]`);
    if (li) li.className = g.pass ? 'ok' : 'bad';
  });

  const allGreen = gates.every(g => g.pass) && m.vis > 0.5;

  if (!allGreen) {
    greenRunStart = 0;
    const cue = pickCue(gates, m);
    if (cue) { elCue.textContent = cue; elCue.className = 'cue bad'; }
    elReady.textContent = m.vis > 0.5 ? 'NOT YET' : 'STEP INTO FRAME';
    elReady.className = 'ready wait';
    // hold clock PAUSES, does not reset
  } else {
    if (!greenRunStart) greenRunStart = now;
    const greenFor = now - greenRunStart;
    if (greenFor >= READY_MS) {
      holdAccum += dt;
      elReady.textContent = 'READY — HOLD'; elReady.className = 'ready ok';
      elCue.textContent = pose.cues.join(' · '); elCue.className = 'cue';
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
    finishPose();
  }
}

// ── camera + model ───────────────────────────────────────────────────────
async function startCamera() {
  elStart.disabled = true; elStart.textContent = 'STARTING…';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;

  if (!landmarker) {
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
    });
  }
  running = true; elStart.textContent = 'RUNNING'; elStart.disabled = true;
  loop();
}

function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  elStop.disabled = true;
  elStart.disabled = false; elStart.textContent = 'START SESSION';
}

function stopSession() {
  stopCamera(); state = 'idle';
  elReady.textContent = 'STOPPED'; elReady.className = 'ready wait';
  if (session && session.poses.length) elExport.disabled = false;
}

// ── export ───────────────────────────────────────────────────────────────
function summaryText() {
  if (!session) return '';
  const lines = [`TITAN POSE — ${session.session.date.slice(0, 10)}`];
  let pass = 0, total = 0;
  session.poses.forEach(p => {
    const g = p.gates.filter(x => x.target !== 'manual');
    const pg = g.filter(x => x.pass).length;
    pass += pg; total += g.length;
    lines.push(`${p.label}: held ${p.hold_seconds}s · ${pg}/${g.length} gates`);
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
  try { await startCamera(); startSession(); }
  catch (e) { elStart.disabled = false; elStart.textContent = 'START SESSION';
              elReady.textContent = 'CAMERA/MODEL FAILED — see console'; console.error(e); }
});
elStop.addEventListener('click', stopSession);
elExport.addEventListener('click', exportSession);
elCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(elSummary.textContent); elCopy.textContent = 'COPIED'; }
  catch { elCopy.textContent = 'select + copy manually'; }
  setTimeout(() => elCopy.textContent = 'Copy summary', 1500);
});
elExport.disabled = true;
