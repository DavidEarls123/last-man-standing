import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = async (n) => { await page.waitForTimeout(800); await page.screenshot({ path: `/tmp/shots/${n}.png`, fullPage: true }); console.log('shot', n); };

async function signIn(identifier, password) {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', identifier);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1600);
}

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await shot('n01-signin');

await signIn(process.env.PLAYER_EMAIL, 'demo-password-1234');
await shot('n02-leagues');
await page.click('.card:has-text("Pub LMS")');
await page.waitForTimeout(1600);
await shot('n03-home');
await page.click('a:has-text("Gameweek")');
await page.waitForTimeout(2000);
await shot('n04-gameweek');
const pick = page.locator('a:has-text("Pick")');
if (await pick.count()) { await pick.first().click(); await page.waitForTimeout(1600); await shot('n05-pick'); }

await page.click('button:has-text("Sign out")');
await page.waitForTimeout(900);
await signIn('league.admin@example.com', 'demo-password-1234');
await page.click('.card:has-text("Pub LMS")');
await page.waitForTimeout(1400);
await page.click('a:has-text("Manage")');
await page.waitForTimeout(1800);
await shot('n06-manage');

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
