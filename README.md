# FitForge

Workout planner: build plans on a 3D body, run them with a tap-to-advance timer, and track your times.

- `public/index.html` is the whole web app.
- `server.js` is an Express API backed by Postgres. It handles accounts, saved data, usage events and the admin dashboard.

## Environment variables
| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `ADMIN_EMAILS` | Comma-separated emails that get the admin dashboard once verified |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional. Send real verification emails via Resend; without them the code is shown on screen |

Run locally with `npm install && DATABASE_URL=... node server.js`.
