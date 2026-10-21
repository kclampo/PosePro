# TITAN POSE

Real-time bodybuilding posing gate trainer. Runs **entirely on the phone** — no account, no
server, no credentials, no uploads. Camera in, green/red joints out.

Built for a 50+ masters bodybuilder learning the seven NPC mandatories against a measured
standard, with a randomised judge-style order and a 10-second hold requirement.

---

## What it does

1. **Randomised pose order** — shuffled each session, so you never rehearse the same sequence twice
2. **Live skeleton overlay** — each gated joint turns **green** (in tolerance) or **red** (out)
3. **One cue at a time** — the screen never shows a number, only the single thing to fix
4. **READY light** — appears once every gate has been green for 0.8 s
5. **10-second hold** — starts only while green. **Pauses if you break the pose; never resets**
6. **POSE LOCKED** — then it advances automatically
7. **Session export** — share sheet (WhatsApp / Drive / AirDrop) or download as JSON, plus a
   copyable plain-text summary

---

## Deploy to GitHub Pages

```bash
# one-time
gh repo create titan-pose --public --source=. --remote=origin --push

# enable Pages from the main branch root
gh api -X POST repos/:owner/titan-pose/pages \
  -f "source[branch]=main" -f "source[path]=/"

# URL appears at:
gh api repos/:owner/titan-pose/pages --jq .html_url
```

**Phone:** open the Pages URL → allow camera → **Add to Home Screen** for a full-screen
standalone app.

⚠️ **Camera requires HTTPS.** GitHub Pages provides it. `file://` and plain `http://` on a
non-localhost origin will **not** get camera access.

---

## Gate status — read this before trusting a number

Every gate is **body-relative** (`torso = |hipMidY − shoulderMidY|`), so it survives a change of
camera distance. Raw image fractions do not.

| Status | Meaning | Count |
|---|---|---|
| **confirmed** | derived from real stage frames of Abarca / Zarif / Bembry, 2026-10-21 | 13 |
| **estimated** | reasoned from the IFBB rulebook, **not yet validated on your footage** | 4 |
| **manual** | judge-visible but landmarks cannot measure it — you tick it yourself | 3 |

### Calibrated values (from real frames)

| Measure | Value | Source |
|---|---|---|
| Abs & Thigh — elbow height | **≥ 0.45 torso** (Bembry 0.49–0.52, Kevin 0.265) | 7 Bembry frames |
| Double Biceps — elbow height | **−0.05 … +0.10 torso** (Kevin +0.046, Abarca +0.023, Zarif −0.093) | 3 athletes |
| Side pose — span/torso | **< 0.70** (sides 0.13–0.50 vs front/back 0.90–1.21) | 15 frames |
| Elbow angle, double biceps | 65–110° | stage frames |
| Symmetry | < 4° left/right elbow | stage frames |
| Shoulder line | < 3° from horizontal | stage frames |

**⚠️ Session one is a calibration run.** The `estimated` bands (lat-spread elbow height, lat-spread
symmetry) should be adjusted from your own footage after it.

---

## The JSON it emits

Matches the ingest signature at `/config/.hermes/scripts/pose_session_ingest.py`, so a file shared
over WhatsApp is auto-logged to `/config/.hermes/profiles/default/memory/pose_sessions/`.

```json
{
  "session": { "date": "ISO-8601", "app": "titan-pose v1.0",
               "order": ["back_lat_spread", "front_double_biceps", "..."] },
  "poses": [
    {
      "pose": "abs_thigh",
      "label": "Abdominals & Thighs",
      "hold_seconds": 10.00,
      "attempts": 1,
      "gates": [
        { "name": "elbow_high", "pass": false, "value": 0.265,
          "target": "[0.45, 1.2]", "status": "confirmed" }
      ]
    }
  ]
}
```

**Every gate carries its value AND its target**, which is what lets the coach say *"you were at
0.265, you need 0.45, here is the cue"* instead of just "failed".

---

## Known limits — stated so nobody has to discover them

- **Front vs back is not auto-detected.** The pose is declared by the session order. (Offline Python
  tooling can classify facing from `nose_z − ear_z`; the browser build does not bother.)
- **Leg flex cannot be measured.** Knee angle barely changes when you lock a quad. The "leg lock" is
  your eyes only.
- **Side chest vs side triceps cannot be told apart by landmarks.** Both use the side-on gate; the
  arm-specific criteria are manual ticks.
- **Back-lat-spread rules that stay manual:** feet ≤15 cm apart, showing the opposite calf, and
  trunks not pulled up.
- **Hold clock pauses rather than resets.** Deliberate — resetting on every wobble makes the drill
  punishing and trains hesitation. If you want stricter, change `holdAccum` handling in `app.js`.
- **Mid-transition frames produce ambiguous geometry.** They show as NOT YET, which is correct.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | UI shell |
| `app.js` | camera, MediaPipe, measurements, state machine, export |
| `pose-gates.js` | **the gates — edit this to recalibrate** |
| `styles.css` | dark UI |
| `sw.js` | offline shell |
| `manifest.json` | installable PWA |
| `icon.svg` | app icon |

---

## Local test

```bash
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://127.0.0.1:8765/index.html
```

Verified 2026-10-21: all seven files serve 200, no JS errors, 7 poses registered, service worker
active, and the START path fails gracefully with `NotFoundError: Requested device not found` on a
machine with no camera.
