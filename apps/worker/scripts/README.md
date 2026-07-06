# Local price scrape (residential IP)

The retailers' bot protection (Akamai on AB, a WAF on Sklavenitis, a CDN on
Kritikos) blocks **Cloudflare's Worker egress IPs** — the deployed cron gets
`403`/`503` from them. The identical requests succeed from a residential IP.

So the daily scrape runs **here, on your Mac**, not on Cloudflare:

- `scrape-local.ts` — reads the listings from the **remote** D1 (via `wrangler`,
  already authenticated), fetches each retailer product page over your home
  connection, and writes prices back to the remote D1. Reuses the Worker's
  adapters and its unit-price-sanity / failure helpers, so results match what
  the cron produced when it still worked.
- `run-scrape.sh` — launchd wrapper (puts Node on `PATH`, then runs the script).
- `eu.vagdas.grocery-scrape.plist` — launchd schedule (08:15 Athens, matching the
  old `05:15 UTC` cron).

Cloudflare still hosts the PWA and the read API; only the fetching moved. The
edge cron in `wrangler.toml` is commented out so there's a single writer.

## Run it by hand

```bash
# from the repo root
npm run scrape:local --workspace apps/worker              # scrape + write to remote D1
npm run scrape:local --workspace apps/worker -- --dry-run # fetch only, print the SQL
```

## Schedule it (launchd)

1. Check the two paths at the top of `run-scrape.sh` match your machine:
   - `NODE_BIN` = `dirname "$(which node)"`
   - `REPO`     = this repo's absolute path

2. Symlink the plist into your user LaunchAgents and load it:

   ```bash
   ln -sf "$PWD/apps/worker/scripts/eu.vagdas.grocery-scrape.plist" \
     ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist
   launchctl load ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist
   ```

3. Verify / operate:

   ```bash
   launchctl list | grep grocery-scrape          # is it registered?
   launchctl start eu.vagdas.grocery-scrape       # run once now
   tail -f apps/worker/scripts/scrape.log         # watch output
   launchctl unload ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist  # stop
   ```

Notes:
- If the Mac is asleep at 08:15, launchd runs the missed job on the next wake —
  fine for a daily tracker, but a laptop that's often closed will miss days. A
  small always-on box (or `pmset` a wake) is the robust fix if that matters.
- `scrape.log` is git-ignored.
- After changing `wrangler.toml` (the disabled cron), redeploy for it to take
  effect: `npm run deploy`.
