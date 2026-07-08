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

### A note on Shopify auth (important - this changed Jan 1, 2026)

Shopify retired static `shpat_` tokens for apps created in the Dev
Dashboard (like your `dnp-sync` app). There's no token to copy and paste
anymore - instead the app has a **Client ID** and **Client Secret**, and
the script itself exchanges those for a short-lived (24-hour) token every
time it runs. This is already built into `sync.mjs` - you just need to
supply the Client ID/Secret as secrets, not a token.

### Steps

1. **Finish setting up `dnp-sync` in the Dev Dashboard:**
   - Open the app → **Configuration** (or Versions) → set the Admin API
     scopes to: `read_products`, `write_products`, `read_inventory`,
     `write_inventory` -> save, which creates a new version
   - Click **Install app** on the Overview page (your screenshot showed
     "Installs: 0" - this step hasn't happened yet) -> install it on
     **My Store 3**
   - Go to **Settings** -> copy the **Client ID** and **Client secret**

   Important: this only works if `dnp-sync` and "My Store 3" are in the
   **same Shopify organization** in the Dev Dashboard. If you get a
   `shop_not_permitted` error later, that's almost always why - check
   under **Dev stores** in the Dev Dashboard sidebar that "My Store 3"
   is actually listed there.

2. **Add the two files to a GitHub repo** (a small dedicated repo is fine,
   doesn't need to be your storefront repo):
   - `daily-sync/sync.mjs`
   - `.github/workflows/daily-sync.yml` (rename the provided
     `.github-workflows-daily-sync.yml` to this path)

3. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `SHOPIFY_SHOP` -> just the subdomain, e.g. `pe107x-br` (not the full
     `.myshopify.com` address)
   - `SHOPIFY_CLIENT_ID` -> from step 1
   - `SHOPIFY_CLIENT_SECRET` -> from step 1

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
