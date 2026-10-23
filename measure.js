/* measure.js — TITAN MEASURE
 * On-device capture + validation for the tape and the JP-3 caliper panel.
 * No network. No model. Pure arithmetic, so it can never disagree with itself.
 *
 * ⛔ RULES BAKED IN (do not "helpfully" change these):
 *  - NECK IS PEGGED AT 18.00". It is NOT an input. The above-larynx read is 18.75
 *    and is a trap artefact that silently flatters Navy BF by ~1 point.
 *  - Navy BF is DEAD. Nothing here computes it. JP-3 only.
 *  - Ranges are TYPO GUARDS, not physiological limits. A red field means
 *    "re-read", never "you are wrong".
 */

/* maxDelta = typo guard. A real read moves less than this between sessions;
 * a jump bigger than it is a keying error, not tissue. Waist 0.5" because
 * tape noise is ±0.25" and a week of bulking moves it 0–0.25". The 10-20
 * "37.25" was +1.25" in one day — 5× the tape error and it sailed through a
 * pure range check. This is the check that actually catches it. */
const TAPE = [
  { id:'weight',   name:'Weight',    unit:'lb', min:220,  max:240,  step:0.1,   maxDelta:4.0  },
  { id:'waist',    name:'Waist',     unit:'in', min:35,   max:38,   step:0.25,  maxDelta:0.5  },
  { id:'shoulders',name:'Shoulders', unit:'in', min:57,   max:59,   step:0.25,  maxDelta:0.75 },
  { id:'chest',    name:'Chest',     unit:'in', min:47,   max:52,   step:0.25,  maxDelta:0.75 },
  { id:'hips',     name:'Hips',      unit:'in', min:42,   max:45,   step:0.25,  maxDelta:0.75 },
  { id:'arms',     name:'Arms',      unit:'in', min:16.5, max:19,   step:0.125, maxDelta:0.5  },
  { id:'thighs',   name:'Thighs',    unit:'in', min:25,   max:29,   step:0.25,  maxDelta:0.75 }
];

const NECK_PEG = 18.00;

const SITES = [
  { id:'bic',   name:'BICEPS',        feed:'ARM',  min:0.08, max:0.60,
    cue:'Vertical fold. Midpoint acromiale → radiale, FRONT of the arm. Arm hangs limp.' },
  { id:'tri',   name:'TRICEPS',       feed:'ARM',  min:0.05, max:0.50,
    // Kevin, 2026-10-23: "could not get the skin to pull away enough to measure
    // the triceps with my arm straight. Only when I bent the elbow."
    // ⇒ A BENT ELBOW IS NOT A WORKAROUND, IT IS THE BUG. Flexing bunches the
    // triceps, the skin goes taut and there is no fold to lift, so the caliper
    // reads ~0. Three reads came back 0/0/0.25 on a 227 lb man — impossible.
    cue:'Vertical fold, SAME HEIGHT, BACK of the arm. Arm hangs limp, ELBOW STRAIGHT. If the fold will not lift, the triceps is CONTRACTED, not lean — never bend the elbow to get a number.' },
  { id:'chest', name:'CHEST',         feed:'JP-3', min:0.25, max:1.30,
    cue:'Diagonal fold, midway nipple → front armpit crease. Arm relaxed at side.' },
  { id:'abdo',  name:'ABDOMEN',       feed:'JP-3', min:0.40, max:2.00,
    cue:'Vertical fold, 2 cm RIGHT of the navel. THE number that moves JP-3.' },
  { id:'thigh', name:'THIGH',         feed:'JP-3', min:0.15, max:1.20,
    cue:'Vertical fold, midway groin crease → top of kneecap, front of thigh. Standing, weight on the OTHER leg.' },
  { id:'lowab', name:'LOWER ABDOMEN', feed:'DIAG', min:0.20, max:1.50,
    cue:'Vertical fold, midway navel → pubic bone, on/slightly right of midline. THE SPARE TIRE — no formula, tracked alone.' }
];

const DOB = new Date(1977, 9, 28); // 28 Oct 1977
function ageNow(){
  const n = new Date();
  let a = n.getFullYear() - DOB.getFullYear();
  const m = n.getMonth() - DOB.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < DOB.getDate())) a--;
  return a;
}

/* ── last-accepted tape values, persisted on this phone ────────── */
const LS_KEY = 'titan_measure_last_v1';
function loadLast(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveLastIfClean(){
  const tape = {}; let clean = true;
  for (const id in tapeInputs){
    const el = tapeInputs[id].inp;
    if (el.classList.contains('bad')) clean = false;
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) tape[id] = v;
  }
  if (!clean || !Object.keys(tape).length) return false;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ date: new Date().toISOString().slice(0,10), tape }));
    return true;
  } catch { return false; }
}

const median = xs => {
  const v = xs.filter(x => Number.isFinite(x)).sort((a,b) => a-b);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid-1] + v[mid]) / 2;
};
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—';

/* ── build tape inputs ─────────────────────────────────────────── */
const tapeEl = document.getElementById('tape');
const tapeInputs = {};
for (const f of TAPE){
  const wrap = document.createElement('label');
  wrap.className = 'field';
  wrap.innerHTML = `<span>${f.name}<em>${f.unit}</em></span>`;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = f.step;
  inp.inputMode = 'decimal';
  inp.placeholder = '—';
  inp.dataset.id = f.id;
  inp.addEventListener('input', () => { f.value = parseFloat(inp.value); render(); });
  wrap.appendChild(inp);
  const warn = document.createElement('small');
  wrap.appendChild(warn);
  tapeEl.appendChild(wrap);
  tapeInputs[f.id] = { inp, warn, spec: f };
}

/* ── build caliper site cards ──────────────────────────────────── */
const sitesEl = document.getElementById('sites');
const siteInputs = {};
for (const s of SITES){
  const card = document.createElement('div');
  card.className = 'site';
  card.innerHTML = `
    <div class="sitehead">
      <strong>${s.name}</strong>
      <span class="feed ${s.feed.toLowerCase()}">${s.feed}</span>
    </div>
    <p class="sitecue">${s.cue}</p>
    <div class="reads"></div>
    <div class="sitemed">median <b>—</b> <i class="sitewarn"></i></div>`;
  const reads = card.querySelector('.reads');
  const arr = [];
  for (let i = 0; i < 3; i++){
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = 0.01; inp.inputMode = 'decimal';
    inp.placeholder = `#${i+1}`;
    inp.addEventListener('input', render);
    reads.appendChild(inp);
    arr.push(inp);
  }
  sitesEl.appendChild(card);
  siteInputs[s.id] = {
    spec: s, arr,
    med: card.querySelector('.sitemed b'),
    warn: card.querySelector('.sitewarn'),
    card
  };
}

/* ── compute + render ──────────────────────────────────────────── */
function render(){
  const LAST = loadLast();
  let tapeBad = [];
  for (const id in tapeInputs){
    const { inp, warn, spec } = tapeInputs[id];
    const v = parseFloat(inp.value);
    const oob  = Number.isFinite(v) && (v < spec.min || v > spec.max);
    const prev = LAST && LAST.tape ? LAST.tape[id] : undefined;
    const jump = Number.isFinite(v) && Number.isFinite(prev) && Math.abs(v - prev) > spec.maxDelta;
    const bad  = oob || jump;
    inp.classList.toggle('bad', bad);
    inp.placeholder = Number.isFinite(prev) ? String(prev) : '—';
    warn.textContent = oob  ? `expect ${spec.min}–${spec.max}`
                     : jump ? `jumped ${v - prev > 0 ? '+' : ''}${(v - prev).toFixed(2)} from ${prev} — re-read`
                     : '';
    if (bad) tapeBad.push(spec.name);
  }
  document.getElementById('tapeWarn').textContent =
    tapeBad.length ? `⛔ RE-READ: ${tapeBad.join(', ')} outside the expected range.` : '';
  document.getElementById('tapeWarn').classList.toggle('bad', tapeBad.length > 0);

  const med = {};
  for (const id in siteInputs){
    const { spec, arr, med: medEl, warn } = siteInputs[id];
    const vals = arr.map(i => parseFloat(i.value));
    let badIdx = [];
    vals.forEach((v, i) => {
      const bad = Number.isFinite(v) && (v < spec.min || v > spec.max);
      arr[i].classList.toggle('bad', bad);
      if (bad) badIdx.push(i+1);
    });
    const m = median(vals);
    med[id] = m;
    medEl.textContent = Number.isFinite(m) ? fmt(m, 3) : '—';
    warn.textContent = badIdx.length ? ` ⛔ read ${badIdx.join('/')} out of range` : '';
  }

  const W  = tapeInputs.weight.inp.value ? parseFloat(tapeInputs.weight.inp.value) : NaN;
  const wa = parseFloat(tapeInputs.waist.inp.value);
  const sh = parseFloat(tapeInputs.shoulders.inp.value);

  const jp3 = ['chest','abdo','thigh'].every(k => Number.isFinite(med[k]));
  let S = NaN, bf = NaN, lean = NaN, fat = NaN;
  if (jp3){
    S = (med.chest + med.abdo + med.thigh) * 25.4;   // inches -> mm
    const A = ageNow();
    const D = 1.10938 - 0.0008267*S + 0.0000016*S*S - 0.0002574*A;
    bf = (4.95/D - 4.50) * 100;
    if (Number.isFinite(W)){ lean = W*(1-bf/100); fat = W*bf/100; }
  }

  const ratio = (Number.isFinite(sh) && Number.isFinite(wa) && wa > 0) ? sh/wa : NaN;
  const gateRaw = Number.isFinite(sh) ? Math.round((sh/1.56)*4)/4 : NaN;
  const gate = Number.isFinite(gateRaw) ? Math.min(gateRaw, 37.5) : NaN;

  const lines = [];
  lines.push(`MEASURE ${new Date().toISOString().slice(0,10)}`);
  lines.push(`wt ${fmt(W,1)} | waist ${fmt(wa,2)} | sh ${fmt(sh,2)} | chest ${fmt(parseFloat(tapeInputs.chest.inp.value),2)} | hips ${fmt(parseFloat(tapeInputs.hips.inp.value),2)} | arms ${fmt(parseFloat(tapeInputs.arms.inp.value),3)} | thighs ${fmt(parseFloat(tapeInputs.thighs.inp.value),2)}`);
  lines.push(`NECK peg ${NECK_PEG.toFixed(2)} · JP3 is age ${ageNow()} (DOB 28 Oct 1977)`);
  const sk = SITES.map(s => {
    const vals = siteInputs[s.id].arr.map(i => i.value || '-').join('/');
    return `${s.id} ${vals}`;
  }).join(' | ');
  lines.push(`SKF in: ${sk}`);
  if (jp3){
    lines.push(`JP3 ${S.toFixed(1)}mm = ${bf.toFixed(1)}%` +
      (Number.isFinite(lean) ? ` | lean ${lean.toFixed(1)} fat ${fat.toFixed(1)}` : ''));
  } else {
    lines.push('JP3 — incomplete (need chest + abdo + thigh)');
  }
  if (Number.isFinite(ratio)) lines.push(`ratio ${ratio.toFixed(4)} | waist gate ${gate.toFixed(2)} (cap 37.50)`);
  if (med.lowab) lines.push(`spare tire (lowab) ${fmt(med.lowab,3)} in = ${(med.lowab*25.4).toFixed(1)} mm`);
  if (tapeBad.length) lines.push(`⚠️ OUT OF RANGE: ${tapeBad.join(', ')}`);
  // ⚠️ Skinfold out-of-range was NEVER reported in the export — only tape was.
  // That is how three triceps reads of 0/0/0.25 got forwarded as if they were
  // data. A 0.00 fold is not a lean site, it is a failed pinch.
  const skfBad = SITES.filter(s => Number.isFinite(med[s.id]) && (med[s.id] < s.min || med[s.id] > s.max))
                      .map(s => `${s.id} ${fmt(med[s.id],3)} (expect ${s.min}–${s.max})`);
  if (skfBad.length) lines.push(`⛔ SKF OUT OF RANGE — a 0.00 fold is impossible: ${skfBad.join(', ')}`);

  document.getElementById('out').textContent = lines.join('\n');
}

/* ── copy ──────────────────────────────────────────────────────── */
document.getElementById('copyBtn').addEventListener('click', async () => {
  const txt = document.getElementById('out').textContent;
  const stored = saveLastIfClean();
  try { await navigator.clipboard.writeText(txt); }
  catch { /* fall through to share */ }
  const btn = document.getElementById('copyBtn');
  const old = btn.textContent;
  btn.textContent = stored ? 'COPIED + SAVED' : 'COPIED';
  setTimeout(() => btn.textContent = old, 1400);
  if (navigator.share){
    try { await navigator.share({ text: txt }); } catch {}
  }
});

document.getElementById('dateLbl').textContent = new Date().toISOString().slice(0,10);
render();
