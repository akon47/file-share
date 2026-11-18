// Screenshots of the main screens (light/dark, desktop/mobile) for a visual check.
//   node scripts/screenshots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:8090';
const out = process.argv[3] ?? '.shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const sizes = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } };

for (const theme of ['light', 'dark']) {
  for (const [label, viewport] of Object.entries(sizes)) {
    const ctx = await browser.newContext({
      viewport,
      colorScheme: theme,
      deviceScaleFactor: label === 'mobile' ? 2 : 1,
    });
    const sender = await ctx.newPage();
    const peer = await (await browser.newContext({ viewport, colorScheme: theme })).newPage();
    await sender.goto(base);
    await peer.goto(base);
    await sender.locator('.status.online').waitFor();
    await sender.locator('.peer-tile').first().waitFor();
    await sender.screenshot({ path: path.join(out, `home-${theme}-${label}.png`), fullPage: true });

    await sender.locator('.composer input[type=file]').setInputFiles([
      { name: '2026 여행 사진.zip', mimeType: 'application/zip', buffer: Buffer.alloc(3_200_000) },
      { name: '회의록.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(240_000) },
      { name: 'IMG_0412.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(1_800_000) },
    ]);
    await sender.getByLabel('비밀번호 사용').check();
    await sender.getByPlaceholder('비밀번호', { exact: true }).fill('1234');
    await sender.screenshot({ path: path.join(out, `composer-${theme}-${label}.png`), fullPage: true });
    await sender.getByRole('button', { name: '공유 시작' }).click();
    const link = await sender.getByLabel('공유 링크').inputValue();

    await peer.goto(link);
    await peer.getByPlaceholder('비밀번호').waitFor();
    await peer.screenshot({ path: path.join(out, `receive-password-${theme}-${label}.png`), fullPage: true });
    await peer.getByPlaceholder('비밀번호').fill('1234');
    await peer.getByRole('button', { name: '확인' }).click();
    await peer.getByRole('button', { name: '모두 받기' }).waitFor();
    await peer.screenshot({ path: path.join(out, `receive-list-${theme}-${label}.png`), fullPage: true });
    await sender.locator('.receiver').first().waitFor();
    await sender.screenshot({ path: path.join(out, `sharing-${theme}-${label}.png`), fullPage: true });
    await ctx.close();
    await peer.context().close();
  }
}
await browser.close();
console.log(`saved to ${out}`);
