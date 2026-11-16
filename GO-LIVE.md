# TradeDesk — going live with the new site

One source of data: the JSONBin bin the classic site already uses. The new site
never talks to JSONBin from the browser. It goes through `server.js` (`/api/*`),
which keeps the key private, checks passkeys, and for every save:
**reads the latest bin → applies that one change → checks the 100 KB limit → writes**.
If the read fails, nothing is written.

## 0. Before anything: back up
Open the current site → sidebar → **⬇ JSON**. Keep the file.

## 1. Get the code to GitHub (needs Git)
Vercel deploys from the GitHub repo, so these files must be pushed:
`server.js`, `vercel.json`, `package.json`, `.gitignore`, `.env.example`,
`GO-LIVE.md`, `scripts/`, `redesign/` (its `data/` folder is git-ignored and never deployed).

## 2. Set environment variables in Vercel
Vercel → Project → Settings → Environment Variables (Production):

| Name | Value |
|---|---|
| `JSONBIN_BIN_ID` | the bin id (same one the classic site uses — the long id in `JSONBIN_URL` in `public/js/app.js`) |
| `JSONBIN_KEY` | a JSONBin **access key** with *Bins Read* + *Bins Update*. Best: create a NEW one in JSONBin for the server. |
| `JSONBIN_KEY_TYPE` | `access` |
| `PASSKEY_HASHES` | `Nishant:<hash>;Vinayak:<hash>` — make each with `node scripts/passkey-hash.js Nishant <passkey>` |
| `WRITES_ENABLED` | `false` (view-only to start) |
| `SITE_MODE` | `classic` (old site stays at `/`, new site at `/new`) |

Tip: choose passkeys that are **not** phone numbers — the old site's delete secret is already public in the repo history.

## 3. Stage 1 — look, don't touch (a few days)
Deploy. Open `https://<your-site>/new` (shows **View only**). Compare totals with the old site.
Check `https://<your-site>/api/health` → `connected: true, passkeys: 2`.

## 4. Stage 2 — allow saving
Set `WRITES_ENABLED=true`, redeploy. Save one real entry at `/new`, then confirm the
old site shows it too.

## 5. Stage 3 — make it the main site
Set `SITE_MODE=new`, redeploy. New site at `/`, old site at `/classic`.
**Roll back any time:** set `SITE_MODE=classic` and redeploy (data is untouched).

## 6. After 1–2 weeks of no issues — close the hole
Remove the JSONBin key from `public/js/app.js` (the classic site then stops working),
and delete that old access key in JSONBin. From then on only the server holds a key.

## Limits (JSONBin Free)
- 100 KB per bin. The server refuses any save that would go over, and the site warns at 80%.
- Request pool: new site uses **1 per page open, 2 per save**, no background polling
  (press the **LIVE** badge to refresh).

## Local testing (never touches the real bin)
```
node scripts/mock-jsonbin.js redesign/data/live.json 4174
```
then start the server with `JSONBIN_API=http://127.0.0.1:4174/v3`, `JSONBIN_BIN_ID=test`,
`JSONBIN_KEY=mock-key`, `WRITES_ENABLED=true`, `PASSKEY_HASHES=...` and open
`http://localhost:<PORT>/new/`.
