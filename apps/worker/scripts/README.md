# Local price scrape (residential IP)

The retailers' bot protection (Akamai on AB, a WAF on Sklavenitis, a CDN on
Kritikos) blocks **Cloudflare's Worker egress IPs** — the deployed cron got
`403`/`503` from them. The identical requests succeed from a residential IP.

So the daily scrape runs **here, on your Mac**, not on Cloudflare:

- `scrape-local.ts` — reads the listings from the **remote** D1 (via `wrangler`,
  already authenticated), fetches each retailer product page over your home
  connection, and writes prices back to the remote D1. Reuses the Worker's
  adapters and its unit-price-sanity / failure helpers, so results match what
  the cron produced when it still worked. It **also rebuilds two D1 discovery
  indexes**, `kritikos_catalog` and `ab_catalog`: Kritikos has no server-side
  search (its ~29 MB catalog scan blows the edge CPU budget) and AB's Akamai WAF
  403s the edge while its API is blocked through any proxy, so neither can be
  searched live on the edge. This job (no CPU limit, residential IP) flattens
  each catalog into its D1 table once a day and the edge searches both with a
  cheap `LIKE` — so no residential proxy is needed for interactive edge search.
  That makes this job the single writer to `price_history`, `kritikos_catalog`,
  and `ab_catalog`.
- `eu.vagdas.grocery-scrape.plist` — launchd schedule (08:15 Athens, matching the
  old `05:15 UTC` cron).

How it fetches (politeness, `@grocery/scrapers/polite`): every request carries a
timeout and bounded retries (backoff + jitter on 429/5xx/network errors, one
delayed retry on 403); chains run in parallel but listings within one chain go
sequentially with a jittered gap; the AB catalog crawl paces its ~240 pages
~350 ms apart. AB and Kritikos listings are priced **from the catalog crawl
itself** — no per-listing requests to the two most block-prone chains unless a
SKU is missing from the crawl (then a paced live fetch covers it).

Cloudflare still hosts the PWA and the read API; only the fetching moved. The
edge cron in `wrangler.toml` is commented out so there's a single writer.

## Run it by hand

```bash
# from the repo root
npm run scrape:local --workspace apps/worker              # scrape + write to remote D1
npm run scrape:local --workspace apps/worker -- --dry-run # fetch only, print the SQL
```

## Schedule it (launchd)

The plist runs `npm` **directly** (from `/opt/homebrew`) rather than a wrapper
script. That's deliberate: **macOS won't let a launchd agent execute a file
inside `~/Documents`** (you get `exit 126: Operation not permitted`), but it
*can* read the repo there once its exec entry point lives outside it. So the
plist's `ProgramArguments[0]` is Node's `npm`, `WorkingDirectory` is the repo,
and the log goes to `~/Library/Logs` (also outside `~/Documents`).

1. Check the paths in the plist match your machine:
   - `ProgramArguments[0]` = output of `which npm`
   - `WorkingDirectory`    = this repo's absolute path
   - `EnvironmentVariables > PATH` starts with `dirname "$(which npm)"`

2. Symlink the plist into your user LaunchAgents and load it:

   ```bash
   ln -sf "$PWD/apps/worker/scripts/eu.vagdas.grocery-scrape.plist" \
     ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist
   launchctl load ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist
   ```

3. Verify / operate:

   ```bash
   launchctl list | grep grocery-scrape          # registered? (col 2 = last exit; 0 = ok)
   launchctl start eu.vagdas.grocery-scrape       # run once now
   tail -f ~/Library/Logs/grocery-scrape.log      # watch output
   launchctl unload ~/Library/LaunchAgents/eu.vagdas.grocery-scrape.plist  # stop
   ```

   After editing the plist, `unload` then `load` again for changes to take effect.

Notes:
- If the Mac is asleep at 08:15, launchd runs the missed job on the next wake —
  fine for a daily tracker, but a laptop that's often closed will miss days. A
  small always-on box (or a `pmset` wake) is the robust fix if that matters.
- After changing `wrangler.toml` (the disabled cron), redeploy for it to take
  effect: `npm run deploy`.
