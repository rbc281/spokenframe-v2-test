const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".fdx": "application/xml", ".fountain": "text/plain", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const safePath = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(root, safePath);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => { if (error) { res.writeHead(404).end("Not found"); return; } res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" }); res.end(data); });
});

const check = (condition, message) => { if (!condition) throw new Error(message); };
async function runLayout(browser, baseUrl, viewport, label) {
  const page = await browser.newPage({ viewport });
  await page.goto(baseUrl);
  await page.waitForSelector("#landing-title");
  check((await page.locator("#landing-title").innerText()).includes("Your Screenplay"), `${label}: headline missing`);
  check(await page.locator("#narration-toggle").count() === 0, `${label}: narration toggle remains`);
  await page.locator("#file-input").setInputFiles(path.join(root, "tests/fixtures/representative.fdx"));
  await page.waitForSelector("#player-view:not([hidden])");
  check(await page.locator(".script-unit.dialogue").count() === 3, `${label}: FDX dialogue missing`);
  await page.locator("#next-button").click();
  check((await page.locator("#now-playing-heading").innerText()).startsWith("Traffic glows"), `${label}: navigation failed`);
  check(await page.locator(".script-unit.is-active").count() >= 1, `${label}: synchronized highlight missing`);
  const metrics = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
  check(metrics.body <= metrics.viewport + 1, `${label}: horizontal overflow (${metrics.body}/${metrics.viewport})`);
  const playBox = await page.locator("#play-button").boundingBox(); const nextBox = await page.locator("#next-button").boundingBox();
  check(playBox.width >= 72 && playBox.height >= 72, `${label}: play target is too small`); check(nextBox.width >= 54 && nextBox.height >= 54, `${label}: next target is too small`);
  await page.screenshot({ path: path.join(root, "test-results", `${label}.png`), fullPage: true });
  await page.close();
}

(async () => {
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  await runLayout(browser, baseUrl, { width: 1440, height: 900 }, "desktop"); console.log("✓ desktop layout and synchronized player");
  await runLayout(browser, baseUrl, { width: 360, height: 740 }, "mobile-360"); console.log("✓ narrow mobile layout and touch targets");
  const fountainPage = await browser.newPage({ viewport: { width: 390, height: 844 } }); await fountainPage.goto(baseUrl); await fountainPage.locator("#file-input").setInputFiles(path.join(root, "tests/fixtures/representative.fountain")); await fountainPage.waitForSelector("#player-view:not([hidden])"); check((await fountainPage.locator("#script-format").innerText()) === "FOUNTAIN", "Fountain did not load in browser"); await fountainPage.close(); console.log("✓ Fountain browser import");
  await browser.close(); server.close();
})().catch((error) => { console.error(error); server.close(); process.exit(1); });
