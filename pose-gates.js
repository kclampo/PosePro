/* pose-gates.js — TITAN POSE — gate definitions
 *
 * ALL GATES ARE BODY-RELATIVE so they survive camera distance changes.
 *   torso        = |hipMidY - shoulderMidY|                  (vertical body unit)
 *   elbowAbove   = (shoulderMidY - elbowMidY) / torso         (+ = elbow ABOVE shoulder)
 *   elbowAngle   = mean of left/right elbow angles (deg)
 *   elbowAsym    = |leftElbowAngle - rightElbowAngle| (deg)
 *   shoulderTilt = degrees of shoulder-line tilt from horizontal
 *   spanTorso    = shoulderSpan / torso
 *
 * CALIBRATION STATUS — shown in the UI, do not hide it.
 *   confirmed  = derived from real stage frames of Abarca / Zarif / Bembry (2026-10-21)
 *   estimated  = reasoned from the rulebook, NOT yet validated on your footage
 *   manual     = a judge-visible item landmarks cannot measure; you tick it yourself
 *
 * Session one is a CALIBRATION RUN. Expect to adjust the estimated bands.
 */

const GATES = {
  // ── caliper-level, measured off real frames ─────────────────────────────
  elbowAbove: { kind: 'measured', unit: 'torso' },

  POSES: [
    {
      id: 'front_double_biceps',
      label: 'Front Double Biceps',
      facing: 'FRONT',
      order: 1,
      cues: [
        'One leg forward and out',
        'Elbows level with your shoulders',
        'Hands clenched, turned down',
      ],
      gates: [
        { id: 'elbow_height', measure: 'elbowAbove', min: -0.05, max: 0.10, status: 'confirmed',
          label: 'Elbows level with shoulders',
          cueLow: 'Drive BOTH elbows UP to shoulder height',
          cueHigh: 'Bring BOTH elbows DOWN to shoulder height' },
        { id: 'elbow_angle', measure: 'elbowAngle', min: 65, max: 110, status: 'confirmed',
          label: 'Elbows bent',
          cueLow: 'Bend your elbows more',
          cueHigh: 'Open your elbows slightly' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 4, status: 'confirmed', sideAware: true,
          label: 'Left and right even',
          cueHigh: 'Raise your {side} elbow to match' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'confirmed',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
      ],
    },

    {
      id: 'front_lat_spread',
      label: 'Front Lat Spread',
      facing: 'FRONT',
      order: 2,
      cues: ['Hands on your waist', 'Elbows WIDE', 'Rib cage up'],
      gates: [
        { id: 'elbow_below', measure: 'elbowAbove', min: -1.0, max: -0.25, status: 'estimated',
          label: 'Elbows down at the waist',
          cueHigh: 'Hands ON your waist — elbows down' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 6, status: 'estimated', sideAware: true,
          label: 'Left and right even',
          cueHigh: 'Match your {side} elbow to the other side' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'estimated',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
      ],
    },

    {
      id: 'side_chest',
      label: 'Side Chest',
      facing: 'SIDE',
      order: 3,
      cues: ['Turn side-on', 'Near arm bent at 90°, far hand grabs the wrist', 'Chest up, arch the rib cage'],
      gates: [
        { id: 'side_on', measure: 'spanTorso', min: 0, max: 0.70, status: 'confirmed',
          label: 'Turned side-on',
          cueHigh: 'Turn further side-on to the camera' },
        { id: 'manual_chest', measure: 'manual', status: 'manual',
          label: 'Rib cage expanded (your eyes)' },
      ],
    },

    {
      id: 'side_triceps',
      label: 'Side Triceps',
      facing: 'SIDE',
      order: 4,
      cues: ['Turn side-on', 'Near arm driven BACK behind you', 'Abs drawn in and flexed'],
      gates: [
        { id: 'side_on', measure: 'spanTorso', min: 0, max: 0.70, status: 'confirmed',
          label: 'Turned side-on',
          cueHigh: 'Turn further side-on to the camera' },
        { id: 'manual_abs', measure: 'manual', status: 'manual',
          label: 'Abs drawn in and flexed (your eyes)' },
      ],
    },

    {
      id: 'back_double_biceps',
      label: 'Back Double Biceps',
      facing: 'BACK',
      order: 5,
      cues: ['Back to the camera', 'One foot back on the toes', 'Arch — show the front delt from behind'],
      gates: [
        { id: 'elbow_height', measure: 'elbowAbove', min: -0.05, max: 0.10, status: 'confirmed',
          label: 'Elbows level with shoulders',
          cueLow: 'Drive BOTH elbows UP to shoulder height',
          cueHigh: 'Bring BOTH elbows DOWN to shoulder height' },
        { id: 'elbow_angle', measure: 'elbowAngle', min: 65, max: 110, status: 'confirmed',
          label: 'Elbows bent',
          cueLow: 'Bend your elbows more',
          cueHigh: 'Open your elbows slightly' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 4, status: 'confirmed', sideAware: true,
          label: 'Left and right even',
          cueHigh: 'Raise your {side} elbow to match' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'confirmed',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
      ],
    },

    {
      id: 'back_lat_spread',
      label: 'Back Lat Spread',
      facing: 'BACK',
      order: 6,
      cues: ['Back to the camera', 'Hands on your waist, elbows WIDE', 'Show the OPPOSITE calf from your back double'],
      gates: [
        { id: 'elbow_below', measure: 'elbowAbove', min: -1.0, max: -0.25, status: 'estimated',
          label: 'Elbows down at the waist',
          cueHigh: 'Hands ON your waist — elbows down' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 6, status: 'estimated', sideAware: true,
          label: 'Left and right even',
          cueHigh: 'Match your {side} elbow to the other side' },
        { id: 'manual_trunks', measure: 'manual', status: 'manual',
          label: 'Trunks NOT pulled up (forbidden)' },
      ],
    },

    {
      id: 'abs_thigh',
      label: 'Abdominals & Thighs',
      facing: 'FRONT',
      order: 7,
      cues: ['Hands behind your head', 'Drive BOTH elbows UP toward your EARS, slightly forward', 'Blow ALL your air out'],
      // ⛔ 2026-10-23 — THIS POSE'S LANDMARKS ARE UNRELIABLE, NOT THE ATHLETE'S BODY.
      // Kevin's run returned elbowAbove = -0.524 (elbows half a torso BELOW the
      // shoulders, on a pose where they must be above) AND elbowAsym = 48.3 deg.
      // A human cannot hold 48 deg of elbow asymmetry. Hands clasped behind the
      // head occlude the wrist/elbow landmarks and the model guesses.
      // ⇒ elbow_high and symmetry are ADVISORY: still reported, never blocking,
      //   until this pose gets a measurement that survives occlusion.
      gates: [
        { id: 'elbow_high', measure: 'elbowAbove', min: 0.45, max: 1.2, status: 'estimated', advisory: true,
          label: 'Elbows driven high',
          cueLow: 'ELBOWS UP — drive them toward your EARS, not out to the sides' },
        { id: 'elbow_angle', measure: 'elbowAngle', min: 40, max: 62, status: 'estimated', advisory: true,
          label: 'Hands behind the head',
          cueLow: 'Bring your hands closer behind your head',
          cueHigh: 'Open your hands out from behind your head' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 4, status: 'estimated', sideAware: true, advisory: true,
          label: 'Left and right even',
          cueHigh: 'Raise your {side} elbow to match' },
      ],
    },

    // ── v1.7 ADDITIONS ───────────────────────────────────────────────────
    // Most Muscular is a FREE pose in the rulebook ("favourite most-muscular
    // pose, when requested") so it can NEVER be auto-detected — elbowAbove puts
    // it entirely inside the front-lat-spread band. The app DECLARES it, which
    // is why the athlete is told the variant to hit.
    {
      id: 'most_muscular',
      label: 'Most Muscular (hands clasped)',
      facing: 'FRONT',
      order: 8,
      cues: [
        'Hands CLASPED in front of your lower chest',
        'Drive both elbows OUT and slightly DOWN',
        'Push your chest TOWARD the camera',
      ],
      gates: [
        // Band from 6 placed stage athletes, two independent measurement
        // methods agreeing within 0.03 torso-lengths:
        //   Abarca (50+ HW) / Cooley (35+ SHW) / Taylor (50+ LW)
        //   Pearson / Garcia / Clarida (2026 Mr Olympia 212)
        { id: 'elbow_below', measure: 'elbowAbove', min: -0.61, max: -0.39, status: 'confirmed',
          label: 'Elbows below the shoulder line',
          cueLow: 'Elbows too LOW — drive them UP toward shoulder height',
          cueHigh: 'Elbows too HIGH — drive them DOWN and OUT' },
        { id: 'elbow_angle', measure: 'elbowAngle', min: 69, max: 101, status: 'confirmed',
          label: 'Elbows bent',
          cueLow: 'Bend your elbows more — bring the clasp closer in',
          cueHigh: 'Open the elbows out a little' },
        { id: 'symmetry', measure: 'elbowAsym', min: 0, max: 10, status: 'confirmed', sideAware: true,
          label: 'Left and right even',
          cueHigh: 'Match your {side} elbow to the other side' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'confirmed',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
        { id: 'manual_clasp', measure: 'manual', status: 'manual',
          label: 'Hands actually clasped, chest pushed forward (your eyes)' },
      ],
    },

    // Quarter turns are RELAXED symmetry-round poses, not mandatories.
    // Only the side-on gate is verified (side poses read spanTorso <=0.50 vs
    // >=0.90 front/back). Everything else here is ESTIMATED — session 1 tunes it.
    // NOTE: the app says which turn to make, so left vs right never has to be
    // inferred from landmarks.
    {
      id: 'quarter_turn_right',
      label: 'Quarter Turn — Right',
      facing: 'SIDE',
      order: 9,
      cues: ['Stand TALL and relaxed', 'Turn so your RIGHT side faces the camera', 'Arms hang, no flexing'],
      gates: [
        { id: 'side_on', measure: 'spanTorso', min: 0, max: 0.70, status: 'confirmed',
          label: 'Turned side-on',
          cueHigh: 'Turn further — you are still too square to the camera' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'estimated',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
        { id: 'manual_posture', measure: 'manual', status: 'manual',
          label: 'Tall, relaxed, standing leg set (your eyes)' },
      ],
    },
    {
      id: 'quarter_turn_left',
      label: 'Quarter Turn — Left',
      facing: 'SIDE',
      order: 10,
      cues: ['Stand TALL and relaxed', 'Turn so your LEFT side faces the camera', 'Arms hang, no flexing'],
      gates: [
        { id: 'side_on', measure: 'spanTorso', min: 0, max: 0.70, status: 'confirmed',
          label: 'Turned side-on',
          cueHigh: 'Turn further — you are still too square to the camera' },
        { id: 'shoulder_level', measure: 'shoulderTilt', min: -3, max: 3, status: 'estimated',
          label: 'Shoulders level',
          cueLow: 'Drop your high shoulder',
          cueHigh: 'Drop your high shoulder' },
        { id: 'manual_posture', measure: 'manual', status: 'manual',
          label: 'Tall, relaxed, standing leg set (your eyes)' },
      ],
    },
  ],
};

/* Which landmark angular convention the score compares against.
 * 'high' = bigger number is better; 'target' = a band; used only for display. */
const STATUS_LABEL = {
  confirmed: 'calibrated on stage frames',
  estimated: 'ESTIMATED — session 1 recalibrates this',
  manual: 'your eyes — landmarks cannot measure it',
};
