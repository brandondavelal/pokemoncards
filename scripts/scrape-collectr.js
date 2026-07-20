// Scrapes the main Collectr showcase (@brandonlal, written to the repo root) plus every
// additional profile under profiles/<name>/ (scraped from the handle @<name> — the folder
// name IS the Collectr handle). Run from a real, local, headed browser session —
// Collectr's CloudFront WAF blocks plain HTTP clients, headless browsers, and even
// Cloudflare's remote Browser Rendering, but a genuine local desktop browser gets
// through. Intended to be run periodically via launchd (see
// scripts/com.pokemongallery.scrapecollectr.plist).
//
// Usage: node scrape-collectr.js
// Writes: data.js + images/pokemon/<id>.<ext> for the main profile, and
//         profiles/<name>/data.js for each additional profile. Images live in one
//         shared images/pokemon/ folder (deduped by Collectr's catalog product id —
//         the same physical product can show up in more than one person's collection)
//         and profile data.js files reference that shared folder. Sealed/non-card
//         products are skipped; only cards are written.

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

const API_BASE = "https://api-v2.getcollectr.com";
const PAGE_SIZE = 30;

const REPO_ROOT = path.resolve(__dirname, "..");
const IMG_DIR = path.join(REPO_ROOT, "images", "pokemon");
const PROFILES_DIR = path.join(REPO_ROOT, "profiles");
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

// Main profile writes to the repo root; every subdirectory of profiles/ is scraped
// from the handle matching its folder name.
function listProfiles() {
  const profiles = [{ handle: "@brandonlal", outDir: REPO_ROOT }];
  if (fs.existsSync(PROFILES_DIR)) {
    for (const name of fs.readdirSync(PROFILES_DIR)) {
      if (fs.statSync(path.join(PROFILES_DIR, name)).isDirectory()) {
        profiles.push({ handle: `@${name}`, outDir: path.join(PROFILES_DIR, name) });
      }
    }
  }
  return profiles;
}

async function fetchProducts(page, handle) {
  let offset = 0;
  let products = [];
  while (true) {
    const batch = await page.evaluate(async ({ base, profile, off, limit }) => {
      const r = await fetch(`${base}/data/showcase/${profile}?offset=${off}&limit=${limit}&unstackedView=true&username=00000000-0000-0000-0000-000000000000`);
      if (!r.ok) return null;
      const j = await r.json();
      return j.products || [];
    }, { base: API_BASE, profile: handle, off: offset, limit: PAGE_SIZE });

    if (batch === null) throw new Error(`showcase fetch failed for ${handle} at offset ${offset}`);
    products = products.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return products;
}

async function scrapeAll() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const profiles = listProfiles();

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  log("fetching grading scales...");
  const gradeMap = await page.evaluate(async ({ base }) => {
    const r = await fetch(`${base}/data/grading-scales`);
    const j = await r.json();
    const map = {};
    (j.data || []).forEach((g) => { map[g.id] = g; });
    return map;
  }, { base: API_BASE });

  const changedPaths = [];

  for (const { handle, outDir } of profiles) {
    log(`${handle}: navigating to showcase page...`);
    await page.goto(`https://app.getcollectr.com/showcase/profile/${handle}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);

    const rawProducts = await fetchProducts(page, handle);
    // cards only — sealed products and other non-card items are excluded from the binder.
    const products = rawProducts.filter((p) => p.is_card !== false);
    log(`${handle}: ${rawProducts.length} products, ${products.length} cards`);

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
        log(`${handle}: image download failed:`, p.product_id, e.message);
      }
    }
    log(`${handle}: images downloaded ${downloaded}, failed ${failed.length}`);

    const imgPathPrefix = path.relative(outDir, IMG_DIR).split(path.sep).join("/");
    const cards = products.map((p) => {
      const gradeInfo = gradeMap[p.grade_id];
      const graded = !!gradeInfo;
      const ext = extOf(p.image_url || "");
      return {
        id: p.product_id,
        name: (p.product_name || "").replace(/\s+/g, " ").trim(),
        // best-guess raw field names (mirrors the site's own catalogGroup/cardNumber props);
        // falls back to "" harmlessly if the showcase API uses different keys.
        set: p.catalog_group || p.set_name || "",
        cardNumber: p.card_number || "",
        priceCents: Math.round(parseFloat(p.market_price || 0) * 100),
        graded,
        grade: graded ? gradeInfo.grade_value : "",
        gradingCompany: graded ? gradeInfo.company_symbol : (p.grade_company || ""),
        images: [`${imgPathPrefix}/${p.product_id}.${ext}`],
        status: "Public",
      };
    });

    const dataJsPath = path.join(outDir, "data.js");
    fs.writeFileSync(dataJsPath, "var GALLERY_DATA = " + JSON.stringify(cards, null, 2) + ";\n");
    log(`${handle}: wrote ${cards.length} cards to ${path.relative(REPO_ROOT, dataJsPath)}`);
    changedPaths.push(path.relative(REPO_ROOT, dataJsPath));
  }

  await browser.close();
  changedPaths.push(path.relative(REPO_ROOT, IMG_DIR));

  if (AUTO_PUSH) {
    pushChanges(changedPaths);
  } else {
    log("AUTO_PUSH is off — data.js/images updated locally only, not pushed to GitHub.");
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function pushChanges(paths) {
  try {
    const status = git(["status", "--porcelain", "--", ...paths]);
    if (!status) {
      log("git: no changes to scraped data, skipping commit/push.");
      return;
    }
    git(["add", ...paths]);
    git(["commit", "-m", `Auto-refresh Collectr data (${new Date().toISOString()})`]);
    git(["push"]);
    log("git: pushed refreshed data to remote.");
  } catch (err) {
    log("git: auto-push failed:", err.message);
  }
}

scrapeAll().then(() => {
  log("done.");
  process.exit(0);
}).catch((err) => {
  console.error(LOG_PREFIX(), "FATAL:", err);
  process.exit(1);
});
