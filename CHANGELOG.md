# FitForge changelog

Versions follow `MAJOR.MINOR.PATCH`:
- **MINOR** (2.1 → 2.2) for new features
- **PATCH** (2.1.0 → 2.1.1) for fixes and small tweaks
- **MAJOR** for big redesigns

The version lives in two places that must match:
- `package.json` → `"version"` (the server reports it at `/api/config`)
- `public/index.html` → `APP_VERSION` and the `CHANGELOG` list (shown in the app's "What's new" sheet, in English and Hebrew)

When they differ, a phone that still has the old page open shows an "update available" bar.

## 2.7.0 — 2026-11-28
- More realistic 3D body on the muscle screen: one smooth sculpted mesh (`public/body-mesh.bin`, built by `tools/build-body.js`) with real proportions, defined muscles and filmic studio lighting.
- Selected muscle is highlighted with soft edges; tap picking unchanged.

## 2.6.0 — 2026-11-28
- Yoga (15 poses, `yoga:1`, grouped by `yg`: stand/balance/floor; default 1 set, 10 s rest) and Calisthenics (`isCali`: bodyweight/chair/table/step + bar moves, grouped Push/Pull/Legs/Core/Full body/Skills; new Burpees, Pistol Squat, L-Sit, Wall Handstand Hold, Hanging Knee Raise)
- Muscle step: "Or browse by style" cards; exercise step filter chips All / At home / Calisthenics / Yoga; plan categories `yoga` and `cali` (server whitelist too)
- Plan helper skips yoga and Skills moves

## 2.5.1 — 2026-11-24
- Plank Shoulder Taps: both arms drawn (far arm `far` shade); hands alternate, the other stays planted. `fig()` supports `far:[joints]` and `*2` joints map to the same muscle segments

## 2.5.0 — 2026-11-24
- Figures: per-segment thickness, dark outline pass, filled front torso, ground shadow; worked muscles tinted (main = accent, others = lighter green)
- Muscle map (`muscleMap`, `musclePanel`): front/back body with main and secondary muscles, in how-to sheets, the sets screen, the player and the exercise picker
- Rest screen: large Up next card (animation, set/reps/weight, muscles) above the log editor; work screen shows the next exercise

## 2.4.0 — 2026-11-24
- Web push notifications (lock screen + smartwatch/Apple Watch): "Time's up" and "Rest over", scheduled by the server only while a workout is running and the app is hidden/locked
- Account menu → Notifications: per-device on/off, per-type switches, test button; `public/sw.js` (notifications only, no caching); VAPID keys auto-generated and stored in the `app_kv` table; subscriptions in `push_subs`

## 2.3.0 — 2026-11-24
- Pause button in the workout player: freezes exercise, rest, warm-up/stretching and total timers; paused time is excluded from workout time (stored as `paused` seconds on the session)

## 2.2.2 — 2026-11-24
- Body Waves: arms swing forward and up in front of the body (added a straight-out-in-front key pose)

## 2.2.1 — 2026-11-24
- Body Waves animation and instructions: arms swing up as the chest goes back, down as the chest goes forward

## 2.2.0 — 2026-11-23
- Morning wake-up: all moves 40 s; March Slaps replace Jump Twists (existing copies of the routine are updated automatically)
- Wake-up moves no longer auto-suggest longer times; if the user goes past the beep, the plan saves that longer time

## 2.1.0 — 2026-11-21
- Version number next to the FitForge name; tapping it opens "What's new"
- Smoother multi-step animations for the Morning wake-up moves
- A notice when a newer version of the app is available

## 2.0.0 — 2026-11-18
- Set logging, weight suggestions, personal records, My progress page
- Step-by-step instructions for every exercise
- Verification emails (Brevo) and Forgot password
- Weekly goal, streaks, 23 badges, reminders, cheers
- Custom exercises
- Morning wake-up routine

## 1.0.0 — 2026-11-17
- Plan builder with 3D body, workout player, summaries
- Sharing and the Shared plans page
- Plan helper, profile and weight log
- Warm-up & stretching, circuit order, at-home exercises
- Hebrew, feedback, Google sign-in, admin dashboard
