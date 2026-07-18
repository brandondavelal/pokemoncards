// Scheduled scraper for the Collectr showcase (@brandonlal). Run from a real,
// local, headed browser session — Collectr's CloudFront WAF blocks plain HTTP
// clients, headless browsers, and even Cloudflare's remote Browser Rendering,
// but a genuine local desktop browser gets through. Intended to be run
// periodically via launchd (see scripts/com.pokemongallery.scrapecollectr.plist).
//
// Usage: node scrape-collectr.js
// Writes: ../data.js, ../images/pokemon/<id>.<ext>

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

// Off by default: this scraper runs unattended on a timer, and pushing to your
// GitHub repo is the kind of action that should be an explicit opt-in rather
// than something that starts happening silently. Flip to true (or set
// AUTO_PUSH=1 in the environment) once you're ready for scheduled runs to
// publish straight to your live site.
const AUTO_PUSH = process.env.AUTO_PUSH === "1";

const PROFILE = "@brandonlal";
const SHOWCASE_URL = `https://app.getcollectr.com/showcase/profile/${PROFILE}`;
const API_BASE = "https://api-v2.getcollectr.com";
const PAGE_SIZE = 30;

const REPO_ROOT = path.resolve(__dirname, "..");
const IMG_DIR = path.join(REPO_ROOT, "images", "pokemon");
const DATA_JS = path.join(REPO_ROOT, "data.js");
const LOG_PREFIX = () => `[${new Date().toISOString()}]`;

function log(...args) { console.log(LOG_PREFIX(), ...args); }

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function extOf(url) {
  const m = /\.([a-zA-Z]+)\?/.exec(url);
  return m ? m[1].toLowerCase() : "jpg";
}

async function scrape() {
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  log("navigating to showcase page...");
  await page.goto(SHOWCASE_URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2000);

  log("fetching grading scales...");
  const gradeMap = await page.evaluate(async ({ base }) => {
    const r = await fetch(`${base}/data/grading-scales`);
    const j = await r.json();
    const map = {};
    (j.data || []).forEach((g) => { map[g.id] = g; });
    return map;
  }, { base: API_BASE });

  let offset = 0;
  let products = [];
  while (true) {
    const batch = await page.evaluate(async ({ base, profile, off, limit }) => {
      const r = await fetch(`${base}/data/showcase/${profile}?offset=${off}&limit=${limit}&unstackedView=true&username=00000000-0000-0000-0000-000000000000`);
      if (!r.ok) return null;
      const j = await r.json();
      return j.products || [];
    }, { base: API_BASE, profile: PROFILE, off: offset, limit: PAGE_SIZE });

    if (batch === null) throw new Error(`showcase fetch failed at offset ${offset}`);
    log(`offset ${offset}: got ${batch.length} products`);
    products = products.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  await browser.close();
  log(`total products: ${products.length}`);

  // Download any missing images.
  let downloaded = 0, failed = [];
  for (const p of products) {
    const ext = extOf(p.image_url || "");
    const dest = path.join(IMG_DIR, `${p.product_id}.${ext}`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) continue;
    try {
      await downloadFile(p.image_url, dest);
      downloaded++;
    } catch (e) {
      failed.push(p.product_id);
      log("image download failed:", p.product_id, e.message);
    }
  }
  log(`images downloaded this run: ${downloaded}, failed: ${failed.length}`);

  // Build data.js
  const cards = products.map((p) => {
    const gradeInfo = gradeMap[p.grade_id];
    const graded = !!gradeInfo;
    const ext = extOf(p.image_url || "");
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
      images: [`images/pokemon/${p.product_id}.${ext}`],
      status: "Public",
    };
  });

  const js = "var GALLERY_DATA = " + JSON.stringify(cards, null, 2) + ";\n";
  fs.writeFileSync(DATA_JS, js);
  log(`wrote ${cards.length} cards to data.js`);

  if (AUTO_PUSH) {
    pushChanges();
  } else {
    log("AUTO_PUSH is off — data.js/images updated locally only, not pushed to GitHub.");
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function pushChanges() {
  try {
    const status = git(["status", "--porcelain", "--", "data.js", "images/pokemon"]);
    if (!status) {
      log("git: no changes to data.js/images/pokemon, skipping commit/push.");
      return;
    }
    git(["add", "data.js", "images/pokemon"]);
    git(["commit", "-m", `Auto-refresh Collectr data (${new Date().toISOString()})`]);
    git(["push"]);
    log("git: pushed refreshed data.js/images to remote.");
  } catch (err) {
    log("git: auto-push failed:", err.message);
  }
}

scrape().then(() => {
  log("done.");
  process.exit(0);
}).catch((err) => {
  console.error(LOG_PREFIX(), "FATAL:", err);
  process.exit(1);
});
