# Daily DVP → Shopify Sync — Setup

## What this does
Once a day: refreshes the EUR→GBP rate, checks stock + current cost for every
tracked product on DVP, updates Shopify's stock status metafield, and
recalculates the retail price using the shop's markup settings.

## Why this can't just "run itself" from inside a chat
Claude only executes while you're actively talking to it — there's no way for
it to wake up tomorrow on its own. This script needs to live somewhere that
runs on a schedule. GitHub Actions (free for this volume of usage) is the
simplest option since it's just cron + secrets, no server to maintain.

## Setup steps

1. **Add the two files to a GitHub repo** (a small dedicated repo is fine,
   doesn't need to be your storefront repo):
   - `daily-sync/sync.mjs`
   - `.github/workflows/daily-sync.yml` (rename the provided
     `.github-workflows-daily-sync.yml` to this path)

2. **Create a Shopify Admin API token** with these scopes:
   `read_products`, `write_products`, `read_inventory`, `write_inventory`
   (Settings → Apps and sales channels → Develop apps → Create an app →
   Configure Admin API scopes → Install app → reveal token)

3. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `SHOPIFY_STORE_DOMAIN` → e.g. `pe107x-br.myshopify.com`
   - `SHOPIFY_ADMIN_API_TOKEN` → the token from step 2

4. **Test it manually first**: Actions tab → Daily DVP → Shopify Sync →
   Run workflow. Check the logs before trusting the schedule.

## Things to verify / finish before relying on this in production

- **Stock/price scraping selectors are illustrative.** They're based on the
  patterns seen when a handful of DVP pages were sampled earlier in this
  project (text like "In stock" / "ex VAT €X"). Re-check against the live
  HTML for a representative sample of products before trusting this at
  scale — supplier sites change markup without notice.
- **Inventory quantity wiring is left as a follow-up.** Setting Shopify's
  actual available-quantity (0 vs in-stock) needs your location ID, which
  the script doesn't have yet. There's a comment in `sync.mjs` marking
  exactly where to add it once you've grabbed that ID via:
  `query { locations(first: 1) { edges { node { id } } } }`
- **Rate limiting is deliberate** — a 2.5s delay between each DVP page
  fetch. Don't remove this; it's there to keep this a low-impact, polite
  daily check rather than a rapid-fire scrape.
- **Schedule timing** — currently 05:00 UTC. Adjust the cron line in the
  workflow file if you'd rather it run at a different time.
