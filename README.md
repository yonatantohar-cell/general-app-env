# Autonomous Lead Generation System

A zero-intervention Node.js service. It wakes on a schedule, searches Google for local
businesses across a matrix of categories × locations, and maintains a deduplicated
`leads.csv` of **Business Name, Phone Number and Category** (plus address, website and
rating, which cost nothing extra — see [Cost](#cost-and-the-free-tier)).

Set it up once, start it, and check the CSV whenever you like.

```
CATEGORIES × LOCATIONS  →  Google Places API (New)  →  dedupe/merge  →  data/leads.csv
        config.js               fetcher.js              database.js        + leads.json
                                     ↑                                          ↑
                              node-cron (index.js)                    future dashboard
```

---

## 1. Quick start

```bash
npm install
cp .env.example .env      # then paste your API key into .env
npm run once              # single test harvest — confirms everything works
npm start                 # run forever on the schedule
```

`npm run once` is the setup check: it harvests immediately, writes `data/leads.csv`,
and exits. Once that looks right, switch to `npm start` (or PM2, below).

### Getting the API key

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library →** enable **“Places API (New)”**.
   ⚠️ Enable the one named **(New)**. The old “Places API” is Legacy and Google no longer
   lets new projects enable it — this system targets the new one and will not work with
   legacy-only setups.
3. **Billing → link a billing account.** Required even to use only the free tier; without
   it every request returns `403`.
4. **APIs & Services → Credentials → Create credentials → API key.**
5. Restrict the key (**Edit key → API restrictions → Places API (New)**) so a leaked key
   cannot be used against anything else.
6. Paste it into `.env` as `GOOGLE_MAPS_API_KEY=...`.

---

## 2. Configuration

Everything lives in `.env` (see `.env.example` for the fully commented version).

| Variable | Default | What it does |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | — | **Required.** The app refuses to start without it. |
| `CATEGORIES` | Hebrew business types | Comma-separated. |
| `LOCATIONS` | Israeli cities | Comma-separated. |
| `QUERIES` | *(empty)* | Set to bypass the matrix and run explicit queries. |
| `LANGUAGE_CODE` / `REGION_CODE` | `he` / `IL` | Result language and region bias. |
| `CRON_SCHEDULE` | `0 2 * * 0` | Every Sunday, 02:00. |
| `CRON_TIMEZONE` | `Asia/Jerusalem` | IANA zone; validated at boot. |
| `RUN_ON_START` | `true` | Harvest once on launch instead of waiting. |
| `MONTHLY_CALL_BUDGET` | `950` | Hard stop before you leave the free tier. |
| `MAX_PAGES_PER_QUERY` | `3` | 20 results/page; Google caps at ~3 pages. |
| `REQUIRE_PHONE` | `true` | Drop results with no phone number. |

**Queries are the product of the two lists.** 6 categories × 5 locations = 30 searches per
run. Keep categories narrow: Google returns at most ~60 results per query, so
`מספרות × חיפה` harvests far more than one broad `עסקים בישראל`.

---

## 3. Running it continuously (PM2)

`npm start` dies with your terminal. For a real deployment use PM2:

```bash
npm install -g pm2

pm2 start ecosystem.config.js   # start under supervision
pm2 save                        # remember it across reboots
pm2 startup                     # print the boot command — run what it tells you
```

Day to day:

```bash
pm2 status            # is it alive?
pm2 logs lead-gen     # live output
pm2 restart lead-gen  # after editing .env
pm2 stop lead-gen
```

PM2 restarts the process if it ever dies, and `pm2 startup` brings it back after a reboot —
together that is what makes "set it and forget it" actually true.

<details>
<summary>Alternative: systemd</summary>

```ini
# /etc/systemd/system/lead-gen.service
[Unit]
Description=Lead Generation System
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lead-gen
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
User=leadgen

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lead-gen && journalctl -u lead-gen -f
```
</details>

---

## 4. Output

`data/leads.csv` — the lead table, UTF-8 **with BOM** so Excel renders Hebrew correctly:

| Business Name | Phone Number | Category | Address | Website | Rating | Review Count | Status | Search Query | Search Category | Search Location | Place ID | First Seen | Last Seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

`data/leads.json` — the same rows as JSON, for a future dashboard to `fetch()` directly.

**Deduplication** is automatic and runs on every harvest:
- primary key is Google's `place_id`;
- secondary key is the phone number's last 8 digits, which catches the same business
  listed as both `03-682-0387` and `+972 3-682-0387`;
- re-running refreshes changed fields (phone, rating, website) and bumps `Last Seen`,
  while `First Seen` is preserved as history.

Running the same harvest twice inserts **zero** new rows. That is covered by a test.

---

## 5. Cost and the free tier

Because we request phone numbers, every search bills at Google's **Enterprise** SKU:
**1,000 free calls per month**, then roughly **$35 per 1,000**.

The important design consequence: we ask for the phone number **inside the search**
rather than doing a follow-up Place Details lookup per business.

| Approach | Billed calls | Leads/month on the free tier |
|---|---|---|
| Search, then Place Details per result *(the common tutorial pattern)* | 1 + N | ~1,000 |
| **Phone in the search field mask (what this does)** | 1 per 20 results | **~20,000** |

Since Enterprise is already the top tier, website / rating / review count are included at
no additional cost — which is why the CSV is richer than the three required columns.

`usage.js` tracks calls in `data/usage.json` and **hard-stops** at `MONTHLY_CALL_BUDGET`
(default 950, leaving margin under Google's 1,000). The counter persists across restarts,
so a restart loop cannot re-spend the budget, and it resets automatically on the 1st.

At the default 30 queries × ~3 pages ≈ 90 calls per weekly run, roughly 360 calls/month —
comfortably inside the free tier.

---

## 6. Resilience

| Failure | Behaviour |
|---|---|
| HTTP 429 (rate limit) | Retries with exponential backoff + jitter, honouring `Retry-After`. |
| HTTP 5xx / dropped socket | Same retry policy (`ECONNRESET`, `ETIMEDOUT`, …). |
| HTTP 403 / 401 / 400 | **No retry** — fails immediately with the fix ("enable Places API (New)…"). Retrying a bad key just burns quota. |
| One query fails | Logged; the run continues with the remaining queries. |
| Budget exhausted | Orderly stop; already-collected leads are still saved. |
| Crash mid-write | Impossible to corrupt the CSV: writes go to a temp file and are `rename()`d atomically. |
| Corrupt `leads.csv` | Backed up to `leads.csv.corrupt-<ts>` and reported, never silently overwritten. |
| Uncaught exception | Logged to `error.log`; the process stays alive for the next scheduled run. |

**Logs**
- `logs/run.log` — everything that happened.
- `logs/error.log` — warnings and errors only. This is the file to check.

```bash
tail -f logs/run.log
cat logs/error.log
```

---

## 7. Tests

```bash
npm test
```

24 offline tests, no API key and no quota required — the network is stubbed. They cover
the things that fail silently in this API: pagination token handling, retry/no-retry
policy, the `displayName` object trap, dedupe across formats, BOM encoding, and the
budget guard.

---

## 8. Pushing to a private repository

`.gitignore` already excludes the things that must never be committed:

```
.env          your API key
data/         your leads (and the quota counter)
logs/         may contain query text and error detail
node_modules/
```

Only `.env.example` is committed, as a template with no secret in it.

**Before the first push**
1. `git status` — confirm `.env` is **not** listed.
2. Create the repository as **Private**.
3. Restrict the API key in Cloud Console (step 1.5 above) so a leak is contained.
4. Set a billing budget alert in Cloud Console as a second safety net behind
   `MONTHLY_CALL_BUDGET`.

If a key is ever committed, deleting the file is not enough — it stays in git history.
Rotate the key in Cloud Console immediately.

---

## 9. Project layout

```
index.js              entry point: cron, run lock, process-level error traps
config.js             .env parsing, validation, category × location matrix
fetcher.js            Places API (New): pagination, retries, normalization
database.js           CSV read → dedupe/merge → atomic write (+ JSON mirror)
usage.js              persistent monthly free-tier budget counter
logger.js             leveled logging → run.log + error.log
ecosystem.config.js   PM2 process definition
test/offline.test.js  offline test suite
data/                 leads.csv, leads.json, usage.json   (gitignored)
logs/                 run.log, error.log                  (gitignored)
```

Modules are one-way and independent, so a future dashboard can
`require('./database').readLeads()` (or just read `data/leads.json`) without pulling in
the fetcher or the scheduler.
