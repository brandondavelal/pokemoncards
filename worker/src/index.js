// Proxies the Collectr showcase using Cloudflare's Browser Rendering (a real,
// remote Chromium instance via Puppeteer) rather than a plain fetch(), since
// Collectr's WAF blocks plain HTTP clients (curl, Worker fetch, headless
// fetch-only requests) but allows requests made from within an actual loaded
// page. We navigate to the real showcase page first, then run fetch() from
// inside that page's own context for pagination — exactly what a real visitor's
// browser does.

import puppeteer from "@cloudflare/puppeteer";

const PROFILE = "@brandonlal";
const SHOWCASE_URL = `https://app.getcollectr.com/showcase/profile/${PROFILE}`;
const API_BASE = "https://api-v2.getcollectr.com";
const PAGE_SIZE = 30;
const CACHE_SECONDS = 600;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function toCard(p, gradeMap) {
  const gradeInfo = gradeMap[p.grade_id];
  const graded = !!gradeInfo;
  return {
    id: p.product_id,
    name: (p.product_name || "").replace(/\s+/g, " ").trim(),
    number: p.card_number || "",
    set: (p.catalog_group || "").trim(),
    priceCents: Math.round(parseFloat(p.market_price || 0) * 100),
    wear: p.card_condition || "",
    rarity: p.rarity || "",
    graded,
    grade: graded ? gradeInfo.grade_value : "",
    gradingCompany: graded ? gradeInfo.company_symbol : (p.grade_company || ""),
    images: p.image_url ? [p.image_url] : [],
    status: "Public",
  };
}

async function scrapeViaBrowser(env) {
  const browser = await puppeteer.launch(env.MYBROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(SHOWCASE_URL, { waitUntil: "load", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));

    // grading scale lookup, fetched from inside the page's own context
    const gradeMap = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/data/grading-scales`);
      const j = await r.json();
      const map = {};
      (j.data || []).forEach((g) => { map[g.id] = g; });
      return map;
    }, API_BASE);

    let offset = 0;
    let all = [];
    while (true) {
      const products = await page.evaluate(async (base, profile, off, limit) => {
        const r = await fetch(`${base}/data/showcase/${profile}?offset=${off}&limit=${limit}&unstackedView=true&username=00000000-0000-0000-0000-000000000000`);
        if (!r.ok) return null;
        const j = await r.json();
        return j.products || [];
      }, API_BASE, PROFILE, offset, PAGE_SIZE);

      if (products === null) throw new Error(`showcase fetch failed at offset ${offset}`);
      all = all.concat(products);
      if (products.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return all.map((p) => toCard(p, gradeMap));
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const cards = await scrapeViaBrowser(env);
      const response = new Response(JSON.stringify({ cards }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
          ...CORS_HEADERS,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.stack ? err.stack : err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
  },
};
