/**
 * prerender-products.js
 *
 * Runs at Netlify BUILD time (not in the browser).
 * Pulls the current product list from Firestore over the public REST API
 * and writes plain, crawlable HTML + JSON-LD into index.html between two
 * marker comments. The existing client-side JS (loadProducts/renderProducts)
 * is untouched — it will still fetch live data and overwrite this markup
 * the instant the page loads in a real browser. This block only exists for
 * the split second before JS runs, and for crawlers that don't wait.
 *
 * Usage (Netlify build command):
 *   node prerender-products.js
 *
 * Requires Node 18+ (built-in fetch). No extra npm packages needed.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'shree-mahalaxmi-electricals';
const INDEX_PATH = path.join(__dirname, 'index.html');
const PRODUCTS_START = '<!--PRERENDER_PRODUCTS_START-->';
const PRODUCTS_END = '<!--PRERENDER_PRODUCTS_END-->';
const CATEGORIES_START = '<!--PRERENDER_CATEGORIES_START-->';
const CATEGORIES_END = '<!--PRERENDER_CATEGORIES_END-->';

// Kept in sync with the `categories` array in index.html.
// (Categories are static, so no Firestore call is needed for this part.)
const CATEGORIES = [
  { id: 'geysers', name: 'Geysers & Water Heaters' },
  { id: 'switches', name: 'Switches & Sockets' },
  { id: 'lighting', name: 'Lighting (Indoor & Outdoor)' },
  { id: 'fans', name: 'Ceiling & Table Fans' },
  { id: 'wires', name: 'Electrical Wires & Cables' },
  { id: 'mcb', name: 'MCBs, DBs & Accessories' },
  { id: 'exhaust', name: 'Exhaust Fans' },
  { id: 'stabilizer', name: 'Voltage Stabilizers' },
];

const CATEGORY_NAMES = CATEGORIES.reduce((acc, c) => {
  acc[c.id] = c.name;
  return acc;
}, {});

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Converts a Firestore REST "fields" object into plain JS values.
function parseFirestoreDoc(doc) {
  const out = {};
  const fields = doc.fields || {};
  for (const key of Object.keys(fields)) {
    const val = fields[key];
    if ('stringValue' in val) out[key] = val.stringValue;
    else if ('integerValue' in val) out[key] = Number(val.integerValue);
    else if ('doubleValue' in val) out[key] = val.doubleValue;
    else if ('booleanValue' in val) out[key] = val.booleanValue;
    else if ('nullValue' in val) out[key] = null;
    else out[key] = null; // arrays/maps not needed for this fallback
  }
  return out;
}

async function fetchProducts() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/products?pageSize=300`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Firestore REST fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data.documents) return [];
  return data.documents.map(parseFirestoreDoc);
}

function buildProductCardsHtml(products) {
  if (!products.length) return '';
  return products.map(p => {
    const catName = CATEGORY_NAMES[p.cat] || p.cat || '';
    const price = p.price != null ? `₹${p.price}` : '';
    return `<div class="product-card" data-id="${escapeHtml(p.id)}">
      <div class="product-body">
        <div class="product-cat">${escapeHtml(catName)}</div>
        <h3>${escapeHtml(p.name)}</h3>
        ${price ? `<div class="product-price">${escapeHtml(price)}</div>` : ''}
      </div>
    </div>`;
  }).join('\n');
}

function buildCategoryCardsHtml(products) {
  return CATEGORIES.map(c => {
    const count = products.filter(p => p.cat === c.id).length;
    return `<div class="cat-card" data-cat="${escapeHtml(c.id)}">
      <div class="name">${escapeHtml(c.name)}</div>
      <div class="count">${count} items</div>
    </div>`;
  }).join('\n');
}

function buildProductSchema(products) {
  if (!products.length) return '';
  const items = products.map(p => ({
    '@type': 'Product',
    name: p.name,
    category: CATEGORY_NAMES[p.cat] || p.cat,
    ...(p.price != null ? {
      offers: {
        '@type': 'Offer',
        priceCurrency: 'INR',
        price: p.price,
        availability: p.stock === 'out'
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
      },
    } : {}),
  }));
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item,
    })),
  })}</script>`;
}

async function main() {
  console.log('Fetching products from Firestore...');
  const products = await fetchProducts();
  console.log(`Fetched ${products.length} products.`);

  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  html = injectBetween(
    html, PRODUCTS_START, PRODUCTS_END,
    `${buildProductSchema(products)}\n${buildProductCardsHtml(products)}`,
    'product-grid" id="productGrid"'
  );

  html = injectBetween(
    html, CATEGORIES_START, CATEGORIES_END,
    buildCategoryCardsHtml(products),
    'cat-grid" id="catGrid"'
  );

  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  console.log('index.html updated with prerendered product + category markup.');
}

function injectBetween(html, startMark, endMark, content, hintLocation) {
  const startIdx = html.indexOf(startMark);
  const endIdx = html.indexOf(endMark);

  if (startIdx === -1 || endIdx === -1) {
    console.error(`Could not find ${startMark} / ${endMark} markers in index.html.`);
    console.error(`Add them inside the element containing ${hintLocation} and re-run.`);
    return html; // skip this block, don't crash the whole build
  }

  const injected = `${startMark}\n${content}\n${endMark}`;
  return html.slice(0, startIdx) + injected + html.slice(endIdx + endMark.length);
}

main().catch(err => {
  console.error(err);
  // Don't fail the whole Netlify build if Firestore is briefly unreachable —
  // the site still works fine client-side. Just skip the SEO fallback this run.
  process.exit(0);
});
