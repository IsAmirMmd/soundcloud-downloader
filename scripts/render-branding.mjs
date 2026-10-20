// Renders branding/*.html to the PNGs BotFather takes (see branding/BOTFATHER.md):
//   bot-avatar.png         1280×1280  /setuserpic
//   bot-avatar-coral.png   1280×1280  /setuserpic (the coral variant)
//   banner.png             1280×720   /setdescriptionpic
//
//   node scripts/render-branding.mjs        (needs Playwright with Chromium)

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const dir = new URL('../branding/', import.meta.url);
const SHOTS = [
  { page: 'avatar.html', out: 'bot-avatar.png', width: 1280, height: 1280 },
  { page: 'avatar.html?bg=coral', out: 'bot-avatar-coral.png', width: 1280, height: 1280 },
  { page: 'banner.html', out: 'banner.png', width: 1280, height: 720 },
];

const browser = await chromium.launch();
try {
  for (const s of SHOTS) {
    const page = await browser.newPage({ viewport: { width: s.width, height: s.height } });
    await page.goto(new URL(s.page, dir).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: new URL(s.out, dir).pathname });
    await page.close();
    console.log(`branding/${s.out}`);
  }
} finally {
  await browser.close();
}
