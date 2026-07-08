/**
 * Daily DVP -> Shopify sync
 * ---------------------------------------------------------------
 * Run once per day (via GitHub Actions cron, see workflow file).
 *
 * What it does, in order:
 *   1. Fetches today's EUR->GBP mid-market rate (Frankfurter/ECB, free, no key)
 *      and writes it to shop.metafields.pricing.eur_gbp_rate
 *   2. For every product that has supplier.supplier_product_url set:
 *        - Fetches the DVP product page (politely, with a delay between requests)
 *        - Reads stock status (in_stock / out_of_stock / backorder / unknown)
 *        - Reads current supplier price (EUR ex VAT) in case it's changed
 *        - Recomputes the retail price: cost_eur * rate * (1 + markup%)
 *          using the product's markup_override_percent if set, else the
 *          shop default_markup_percent
 *        - Writes: supplier.stock_status, supplier.supplier_price_eur_ex_vat,
 *          supplier.last_scraped, the variant's inventory (0 if out of stock,
 *          a nominal in-stock quantity otherwise - since this is dropship and
 *          DVP doesn't expose exact counts), and the variant's Price
 *
 * Requires environment variables:
 *   SHOPIFY_STORE_DOMAIN      e.g. pe107x-br.myshopify.com
 *   SHOPIFY_ADMIN_API_TOKEN   Admin API access token with:
 *                             read_products, write_products,
 *                             read_inventory, write_inventory
 *
 * Rate limiting: this script fetches DVP product pages one at a time with a
 * delay (DVP_FETCH_DELAY_MS) between each request. Do not remove this delay -
 * it exists to be a polite, low-impact scraper against a supplier's site,
 * not to run as fast as possible.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = "2025-01";
const DVP_FETCH_DELAY_MS = 2500; // politeness delay between supplier page fetches
const IN_STOCK_NOMINAL_QTY = 999; // dropship proxy quantity - DVP doesn't expose exact counts

if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
  console.error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_TOKEN env vars.");
  process.exit(1);
}

const GRAPHQL_URL = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Step 1: fetch today's EUR->GBP rate and write it to the shop metafield. */
async function refreshExchangeRate() {
  const res = await fetch("https://api.frankfurter.app/latest?from=EUR&to=GBP");
  const json = await res.json();
  const rate = json.rates?.GBP;
  if (!rate) throw new Error("Could not fetch EUR->GBP rate from Frankfurter API.");

  const shopData = await shopifyGraphQL(`query { shop { id } }`);
  const shopId = shopData.shop.id;

  await shopifyGraphQL(
    `mutation SetRate($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: shopId,
          namespace: "pricing",
          key: "eur_gbp_rate",
          value: String(rate),
        },
      ],
    }
  );

  console.log(`EUR->GBP rate updated: ${rate}`);
  return rate;
}

/** Fetch the shop's default markup percent. */
async function getDefaultMarkupPercent() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "pricing", key: "default_markup_percent") {
          value
        }
      }
    }
  `);
  const value = data.shop.metafield?.value;
  return value ? parseFloat(value) : 0;
}

/**
 * Fetch all products that have a supplier.supplier_product_url set.
 * Paginates through the full catalog.
 */
async function getTrackedProducts() {
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(
      `
      query GetProducts($cursor: String) {
        products(first: 50, after: $cursor, query: "metafields.supplier.supplier_product_url:*") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              supplierUrl: metafield(namespace: "supplier", key: "supplier_product_url") { value }
              markupOverride: metafield(namespace: "pricing", key: "markup_override_percent") { value }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                    inventoryItem { id }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { cursor }
    );

    for (const edge of data.products.edges) {
      const node = edge.node;
      if (node.supplierUrl?.value) {
        products.push({
          id: node.id,
          title: node.title,
          supplierUrl: node.supplierUrl.value,
          markupOverride: node.markupOverride?.value ? parseFloat(node.markupOverride.value) : null,
          variantId: node.variants.edges[0]?.node.id,
          inventoryItemId: node.variants.edges[0]?.node.inventoryItem.id,
        });
      }
    }

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

/**
 * Fetch a DVP product page and extract stock status + current price.
 * NOTE: the selectors/patterns below are illustrative based on the pages
 * sampled during initial scraping - re-verify against the live HTML before
 * relying on this in production, since supplier site markup can change.
 */
async function fetchSupplierStockAndPrice(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ASTT-sync-bot/1.0)" },
  });
  if (!res.ok) {
    return { stockStatus: "unknown", priceEurExVat: null };
  }
  const html = await res.text();

  // Stock status: look for the same text patterns seen on scraped pages.
  let stockStatus = "unknown";
  if (/in stock/i.test(html)) stockStatus = "in_stock";
  else if (/out of stock|sold out/i.test(html)) stockStatus = "out_of_stock";
  else if (/backorder|pre.?order/i.test(html)) stockStatus = "backorder";

  // Price (ex VAT): adjust this regex once you've confirmed the exact
  // markup DVP uses for the ex-VAT price display on the live site.
  let priceEurExVat = null;
  const priceMatch = html.match(/(?:ex\.?\s?VAT|excl\.?\s?VAT)[^\d]{0,20}([\d.,]+)/i);
  if (priceMatch) {
    priceEurExVat = parseFloat(priceMatch[1].replace(",", "."));
  }

  return { stockStatus, priceEurExVat };
}

/** Update a single product's stock, price metafields, inventory, and Variant Price. */
async function updateProduct(product, eurGbpRate, defaultMarkupPercent) {
  const { stockStatus, priceEurExVat } = await fetchSupplierStockAndPrice(product.supplierUrl);

  const markup = product.markupOverride ?? defaultMarkupPercent;
  const now = new Date().toISOString();

  // Update metafields: stock status + last scraped (+ price if we got one)
  const metafieldsToSet = [
    { ownerId: product.id, namespace: "supplier", key: "stock_status", value: stockStatus },
    { ownerId: product.id, namespace: "supplier", key: "last_scraped", value: now },
  ];
  if (priceEurExVat !== null) {
    metafieldsToSet.push({
      ownerId: product.id,
      namespace: "supplier",
      key: "supplier_price_eur_ex_vat",
      value: String(priceEurExVat),
    });
  }

  await shopifyGraphQL(
    `mutation SetFields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: metafieldsToSet }
  );

  // Reprice, if we have a cost figure to work from
  if (priceEurExVat !== null && product.variantId) {
    const retailPrice = (priceEurExVat * eurGbpRate * (1 + markup / 100)).toFixed(2);
    await shopifyGraphQL(
      `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      {
        productId: product.id,
        variants: [{ id: product.variantId, price: retailPrice }],
      }
    );
  }

  console.log(
    `${product.title}: stock=${stockStatus}${
      priceEurExVat !== null ? `, cost=€${priceEurExVat}` : ""
    }`
  );

  // Note: setting actual inventory quantity (0 vs nominal) requires the
  // inventoryItemId + a locationId. Fetch your location ID once via
  // `query { locations(first: 1) { edges { node { id } } } }` and pass it
  // through here with inventorySetQuantities. Left as a follow-up wire-up
  // once a real location ID is confirmed, rather than guessed at here.
}

async function main() {
  console.log("Starting daily DVP -> Shopify sync...");

  const rate = await refreshExchangeRate();
  const defaultMarkup = await getDefaultMarkupPercent();
  const products = await getTrackedProducts();

  console.log(`Found ${products.length} tracked products.`);

  for (const product of products) {
    try {
      await updateProduct(product, rate, defaultMarkup);
    } catch (err) {
      console.error(`Failed to update ${product.title}: ${err.message}`);
    }
    await sleep(DVP_FETCH_DELAY_MS);
  }

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
