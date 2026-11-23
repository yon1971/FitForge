# FitForge changelog

Versions follow `MAJOR.MINOR.PATCH`:
- **MINOR** (2.1 → 2.2) for new features
- **PATCH** (2.1.0 → 2.1.1) for fixes and small tweaks
- **MAJOR** for big redesigns

The version lives in two places that must match:
- `package.json` → `"version"` (the server reports it at `/api/config`)
- `public/index.html` → `APP_VERSION` and the `CHANGELOG` list (shown in the app's "What's new" sheet, in English and Hebrew)

When they differ, a phone that still has the old page open shows an "update available" bar.

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
