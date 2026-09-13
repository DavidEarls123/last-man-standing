import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const check = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

await page.goto('http://localhost:3000/');
await page.fill('input[autocomplete="username"]', 'alex.turner@example.com');
await page.fill('input[type="password"]', 'demo-password-1234');
await page.click('button[type="submit"]');
await page.waitForTimeout(1600);
await page.click('.card:has-text("Pub LMS")');
await page.waitForTimeout(1600);

const banner = await page.locator('.alert-warn').allTextContents();
check('home explains the called-off game', banner.some((t) => /game is off/i.test(t)));
await page.screenshot({ path: '/tmp/shots/n07-reselect-home.png', fullPage: true });

await page.click('a:has-text("Pick")');
await page.waitForTimeout(1600);
check('pick page opens the reselection', await page.locator('text=/replacement pick/i').count() > 0);
const disabled = await page.locator('.team-btn[disabled]:has-text("Already kicked off")').count();
check(`teams already playing are locked out (${disabled})`, disabled > 0);
await page.screenshot({ path: '/tmp/shots/n08-reselect-pick.png', fullPage: true });

const options = page.locator('.team-btn:not([disabled])');
const chosen = (await options.first().locator('.team-name').textContent()).trim();
await options.first().click();
await page.click('button:has-text("Confirm round")');
await page.waitForTimeout(1800);
check(`replacement "${chosen}" saved`, await page.locator(`.timeline-item:has-text("${chosen}")`).count() > 0);
check('banner cleared', (await page.locator('.alert-warn').allTextContents()).every((t) => !/game is off/i.test(t)));

console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
