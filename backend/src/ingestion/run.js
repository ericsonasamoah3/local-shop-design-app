#!/usr/bin/env node
// Catalogue ingestion entry point.
//
//   node src/ingestion/run.js --place "Biggleswade, UK" --radius 25000
//
// Runs offline and writes a normalised catalogue file; the API reads that file
// at boot via services/catalogStore.js. Keeping ingestion out of the request
// path means a slow or rude shop can never affect a user, and the whole thing
// costs nothing to run beyond bandwidth.

const fs = require('fs');
const path = require('path');

const { discoverShops } = require('./discover/osm');
const { fetchShopProducts } = require('./platforms/detect');
const { classifyProducts } = require('./normalize/classify');
const { buildCatalog } = require('./normalize/product');

const DEFAULT_OUT = process.env.CATALOG_PATH || path.join(__dirname, '..', '..', 'catalog', 'catalog.json');

function parseArgs(argv) {
  const args = {
    place: 'Biggleswade, UK',
    radius: 25000,
    out: DEFAULT_OUT,
    maxShops: Number(process.env.INGEST_MAX_SHOPS || 40),
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--place': args.place = value; i += 1; break;
      case '--radius': args.radius = Number(value); i += 1; break;
      case '--out': args.out = value; i += 1; break;
      case '--max-shops': args.maxShops = Number(value); i += 1; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':
        console.log('Usage: run.js [--place "Town, UK"] [--radius 25000] [--out path] [--max-shops 40] [--dry-run]');
        process.exit(0);
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`unknown flag: ${flag}`);
          process.exit(1);
        }
    }
  }

  return args;
}

const log = (message) => console.log(message);

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();

  log(`Discovering shops near "${args.place}" within ${args.radius / 1000}km...`);
  const { shops, origin } = await discoverShops(args.place, args.radius, { log });
  log(`  geocoded to ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`);
  log(`  ${shops.length} candidate shops with a website\n`);

  const candidates = shops.slice(0, args.maxShops);
  if (candidates.length < shops.length) {
    log(`  limiting to ${candidates.length} shops (--max-shops)\n`);
  }

  const byShop = new Map();
  const report = [];

  for (const [index, shop] of candidates.entries()) {
    const label = `[${index + 1}/${candidates.length}] ${shop.name}`;
    log(`${label} -- ${shop.website}`);

    let result;
    try {
      result = await fetchShopProducts(shop.website);
    } catch (err) {
      log(`  failed: ${err.message}`);
      report.push({ shop: shop.name, platform: null, raw: 0, kept: 0, note: err.message });
      continue;
    }

    if (!result.platform) {
      log('  no machine-readable catalogue -- skipped');
      report.push({ shop: shop.name, platform: null, raw: 0, kept: 0, note: result.reason });
      continue;
    }

    log(`  ${result.platform}: ${result.products.length} products`);

    const classified = await classifyProducts(result.products, { log });
    log(`  ${classified.length} are bedding\n`);

    byShop.set(shop.website, classified);
    report.push({
      shop: shop.name,
      platform: result.platform,
      raw: result.products.length,
      kept: classified.length,
    });
  }

  const catalog = buildCatalog(candidates, byShop);
  const generated = {
    generated_at: new Date().toISOString(),
    area: args.place,
    radius_m: args.radius,
    ...catalog,
  };

  // --- Summary -------------------------------------------------------------
  const byCategory = catalog.products.reduce((acc, p) => {
    acc[p.category] = (acc[p.category] || 0) + 1;
    return acc;
  }, {});

  log('---');
  log(`Shops with products : ${catalog.shops.length}`);
  log(`Products            : ${catalog.products.length}`);
  for (const [category, count] of Object.entries(byCategory)) {
    log(`  ${category.padEnd(18)}: ${count}`);
  }
  log(`Elapsed             : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const platforms = report.filter((r) => r.platform).reduce((acc, r) => {
    acc[r.platform] = (acc[r.platform] || 0) + 1;
    return acc;
  }, {});
  log(`Platforms           : ${JSON.stringify(platforms)}`);

  if (catalog.products.length === 0) {
    log('\nNo products found. Try a larger --radius, or a town with more independent retail.');
  }

  if (args.dryRun) {
    log('\n--dry-run: nothing written');
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(generated, null, 2));
  log(`\nWrote ${args.out}`);
}

main().catch((err) => {
  console.error(`\ningestion failed: ${err.message}`);
  process.exit(1);
});
