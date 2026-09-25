# DiceCloud — Render → Fly.io Migration Guide

Current setup: Dockerized Meteor app on **Render** (service wakes slowly when
idle — measured 22–30 s cold start), MongoDB **Atlas**, domain
`dice.ardun.me` proxied through **Cloudflare**.

The database does not move. Both Render and Fly talk to the same Atlas
cluster, so the migration is: deploy to Fly → repoint DNS → retire Render.

---

## Part 1 — Code fixes already applied (why rolls were laggy)

See the final session report for details. In short:

1. **`computeVersion` was never written** after a compute. The
   `singleCharacter` publication recomputes the whole creature when
   `computeVersion !== VERSION` — since it could never match, **every sheet
   load and every DDP reconnect blocked the server with a full recompute**
   of every subscribed character. Fixed in
   `app/imports/api/engine/computeCreature.js`.
2. `Dockerfile` now bakes `CONTAINER_VERSION` (from `RENDER_GIT_COMMIT` /
   `--build-arg`) so the version stamp changes with each deploy.
3. `removeOldLogs` never pruned old logs (cursor `.date` bug) — fixed +
   compound index `{creatureId: 1, date: -1}`.
4. Discord webhook now uses a direct HTTPS POST instead of constructing a
   full `discord.js` client per send (less RAM, one less dependency).

---

## Part 2 — Deploy to Fly (one-time, ~20 min)

### 2.1 Install the CLI and authenticate
```powershell
winget install Flyctl.flyctl      # or: irm https://fly.io/install.ps1 | iex
fly auth login
```

### 2.2 Collect your secrets from Render (before touching anything!)
Render dashboard → your `dicecloud` service → **Environment**. Copy the
values of:
- `MONGO_URL` (Atlas connection string)
- `MONGO_OPLOG_URL` (oplog account URL, if set — recommended, enables
  instant log updates instead of polling)
- `ROOT_URL` — must be `https://dice.ardun.me`
- `METEOR_SETTINGS` (if set)
- `MAIL_URL` (if set)
- any other custom variables

### 2.3 Create the Fly app
```powershell
fly apps create dicecloud-ardun     # pick any unique name
```
Open `fly.toml` and set `app = "dicecloud-ardun"`.

**Region: Atlas is in GCP / Belgium (europe-west1)** → `primary_region` is
already set to `bru` (Brussels) in `fly.toml`, which matches.

### 2.4 Machine mode
`fly.toml` currently uses **auto-stop** (machine sleeps when idle, Fly boots
it on the next request — no charge while stopped, expect a ~15-30s wait on
the first hit after idle, same as Render's spin-up). If you change your
mind and want zero cold starts for ~$5-7/mo, set `auto_stop_machines = false`
and `min_machines_running = 1` in `fly.toml` before deploying.

### 2.4 Set secrets
```powershell
fly secrets set \
  MONGO_URL="<atlas url>" \
  MONGO_OPLOG_URL="<atlas oplog url>" \
  ROOT_URL="https://dice.ardun.me"

# If Render had METEOR_SETTINGS, copy it verbatim; otherwise use the defaults:
fly secrets set METEOR_SETTINGS='{"public":{"environment":"production","disablePatreon":true,"disallowCreatureApiImport":false}}'
```

### 2.5 Deploy
```powershell
.\scripts\fly-deploy.ps1 -AppName dicecloud-ardun -Region fra
```
The script passes `CONTAINER_VERSION=<git sha>` so creatures are recomputed
once per engine change, then verifies.

Smoke test: `curl https://dicecloud-ardun.fly.dev/sockjs/info` should return
JSON, and the site should load at `https://<app>.fly.dev`.

---

## Part 3 — Point the domain (Cloudflare)

1. Add the cert in Fly:
   ```powershell
   fly certs add dice.ardun.me --app dicecloud-ardun
   ```
2. In the **Cloudflare dashboard** → DNS → find the existing record for
   `dice` (currently proxied to Render). **Edit it** (don't delete first):
   - Type: `CNAME`
   - Name: `dice`
   - Target: `dicecloud-ardun.fly.dev` (your Fly app's hostname)
   - Proxy status: keep **Proxied (orange cloud)** — WebSockets work fine
     through Cloudflare and you keep DDoS protection. (DNS-only also works;
     Fly then issues the cert directly.)
3. Check cert status until it says active:
   ```powershell
   fly certs check dice.ardun.me --app dicecloud-ardun
   ```
4. Verify `https://dice.ardun.me` loads, log in, and roll some dice while
   watching `fly logs --app dicecloud-ardun`.

## Part 4 — Disconnect Render (only after Fly is verified!)

1. Confirm a few real sessions work through the Fly deployment (rolls land in
   the log *and* Discord).
2. Render dashboard → your service → **Settings → Suspend Service**. This
   stops serving traffic and billing without deleting anything. Keep it
   suspended for a few days as a safety net.
3. Rollback path if anything regressed: switch the Cloudflare CNAME back to
   the Render hostname (`<service>.onrender.com`) and resume the service.
4. When confident, delete the Render service.
5. Nothing else to migrate: Atlas stays as-is, OAuth callback URLs
   (Discord/Google login) still point at `dice.ardun.me`, which didn't change.

---

## Notes & costs

- `fly.toml` currently runs in **auto-stop** mode (per your preference): the
  machine stops when idle and starts on the next request. While stopped you
  pay only for the disk and a reserved IPv4 (~$2/mo); the tradeoff is a
  ~15-30s wait on the first hit after idle. Flip to always-on
  (`auto_stop_machines = false`, `min_machines_running = 1`) any time for
  ~$5-7/mo total and zero cold starts.
- Deploys use `--strategy immediate` (new machine goes live as soon as it's
  healthy; players stay connected).
- If you see `mongo timeout` errors in `fly logs`, Atlas must allow
  connections from Fly's outbound IPs — Atlas "Network Access" with
  `0.0.0.0/0` (or Fly's static egress IPs via `fly ips allocate-v4` +
  dedicated IP config).
- **If your Atlas cluster is the free M0 tier**: oplog access (needed for
  `MONGO_OPLOG_URL` and instant log updates) requires a dedicated tier
  (M10+). On M0 the app falls back to database polling — works, but roll
  updates land up to a few hundred ms later.
