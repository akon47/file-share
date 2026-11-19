// End-to-end check with real browsers against a running server (local only; Jenkins has no browsers).
//   npm run build && PORT=8090 node dist/server/index.js &
//   node scripts/e2e.mjs [baseUrl]
// Covers: share link + wrong/right password + zip of several files, 6-digit code, nearby push with accept,
// Chromium <-> Firefox, resuming 300 MB transfers after a dropped connection (share and nearby), and that no
// page logs CSP or other console errors.
import { chromium, firefox } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'http://localhost:8090';
const out = mkdtempSync(path.join(tmpdir(), 'fs-e2e-'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const errors = [];
let failed = false;

function check(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`  ✗ ${message}`);
  } else console.log(`  ✓ ${message}`);
}

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[${label}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[${label}] ${err.message}`));
}

async function open(browser, label) {
  const context = await browser.newContext({ acceptDownloads: true });
  // Track data channels so a test can drop them (both ends see the channel close, like a lost connection).
  await context.addInitScript(() => {
    const channels = [];
    window.__dcs = channels;
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener('datachannel', (event) => channels.push(event.channel));
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        channels.push(channel);
        return channel;
      }
    };
  });
  const page = await context.newPage();
  watch(page, label);
  await page.goto(base);
  await page.locator('.status.online').waitFor({ timeout: 15_000 });
  // Wait for the download service worker to control the page (first visit).
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 10_000 }).catch(() => {});
  return { context, page };
}

async function saveDownload(download, name) {
  const file = path.join(out, name);
  await download.saveAs(file);
  return readFileSync(file);
}

const big = randomBytes(40 * 1024 * 1024 + 123);
const small = Buffer.from('안녕하세요 file-share 테스트 파일입니다.\n'.repeat(1000));
const image = randomBytes(300_000);

const chrome = await chromium.launch();
const fox = await firefox.launch();

try {
  // ---------- 1. share link with password, several files (zip) ----------
  console.log('1. share link + password + zip');
  const a = await open(chrome, 'A');
  const b = await open(chrome, 'B');
  await a.page.locator('.composer input[type=file]').setInputFiles([
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big },
    { name: '메모.txt', mimeType: 'text/plain', buffer: small },
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: image },
  ]);
  await a.page.getByLabel('비밀번호 사용').check();
  await a.page.getByPlaceholder('비밀번호', { exact: true }).fill('s3cret!');
  await a.page.getByRole('button', { name: '공유 시작' }).click();
  const linkInput = a.page.getByLabel('공유 링크');
  await linkInput.waitFor();
  const link = await linkInput.inputValue();
  check(/\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{22}$/.test(link), `link looks right (${link.replace(/#.*/, '#…')})`);

  await b.page.goto(link);
  await b.page.getByPlaceholder('비밀번호').waitFor({ timeout: 20_000 });
  check(!b.page.url().includes('#'), 'secret removed from the address bar');
  await b.page.getByPlaceholder('비밀번호').fill('wrong');
  await b.page.getByRole('button', { name: '확인' }).click();
  await b.page.getByText('비밀번호가 맞지 않아요').waitFor({ timeout: 15_000 });
  check(true, 'wrong password rejected');
  await b.page.getByPlaceholder('비밀번호').fill('s3cret!');
  await b.page.getByRole('button', { name: '확인' }).click();
  await b.page.getByRole('button', { name: '모두 받기' }).waitFor({ timeout: 15_000 });
  check(await b.page.getByText('확인된 연결').isVisible(), 'sender verified with the link secret');
  const [zipDownload] = await Promise.all([
    b.page.waitForEvent('download', { timeout: 60_000 }),
    b.page.getByRole('button', { name: '모두 받기' }).click(),
  ]);
  const zip = await saveDownload(zipDownload, 'share.zip');
  await b.page.getByText('받기 완료').waitFor({ timeout: 60_000 });
  const zipPath = path.join(out, 'share.zip');
  const listing = execFileSync('python', [
    '-I',
    '-c',
    'import sys,zipfile,hashlib,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({i.filename:hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))',
    zipPath,
  ]).toString();
  const entries = JSON.parse(listing);
  check(entries['big.bin'] === sha(big), `zip: big.bin intact (${(big.length / 1048576).toFixed(1)} MB)`);
  check(entries['메모.txt'] === sha(small), 'zip: Korean file name and content intact');
  check(entries['photo.jpg'] === sha(image), 'zip: photo.jpg intact');
  check(zip.length > big.length, `zip size ${zip.length}`);
  check(
    (await a.page.locator('.receiver .badge', { hasText: '받기 완료' }).count()) === 1,
    'sender sees the receiver as done',
  );

  // single file from the same share
  const [single] = await Promise.all([
    b.page.waitForEvent('download', { timeout: 30_000 }),
    b.page.getByRole('button', { name: '메모.txt 받기' }).click(),
  ]);
  check(sha(await saveDownload(single, 'memo.txt')) === sha(small), 'single file download from the same share');

  // ---------- 2. code ----------
  console.log('2. six-digit code');
  const codeText = (await a.page.locator('.code').first().innerText()).replace(/\D/g, '');
  check(/^\d{6}$/.test(codeText), `code ${codeText}`);
  const c = await open(chrome, 'C');
  await c.page.getByLabel('6자리 코드').fill(codeText);
  await c.page.getByRole('button', { name: '받기', exact: true }).click();
  await c.page.getByPlaceholder('비밀번호').waitFor({ timeout: 20_000 });
  check(!(await c.page.getByText('확인된 연결').isVisible()), 'code join is not marked as link-verified');
  await c.page.getByPlaceholder('비밀번호').fill('s3cret!');
  await c.page.getByRole('button', { name: '확인' }).click();
  await c.page.getByRole('button', { name: '모두 받기' }).waitFor({ timeout: 15_000 });
  check(true, 'code + password reaches the file list');
  await c.context.close();

  // ---------- 3. nearby push (Chromium -> Chromium) ----------
  console.log('3. nearby push');
  await b.page.goto(base);
  await b.page.locator('.status.online').waitFor();
  const bName = (await b.page.locator('.my-device .name').innerText()).trim();
  const tile = a.page.locator('.peer-tile', { hasText: bName });
  await tile.waitFor({ timeout: 15_000 });
  check(true, `A sees B ("${bName}") as a nearby device`);
  await tile.locator('input[type=file]').setInputFiles([{ name: 'hello.txt', mimeType: 'text/plain', buffer: small }]);
  const accept = b.page.getByRole('alertdialog').getByRole('button', { name: '받기' });
  await accept.waitFor({ timeout: 20_000 });
  const [pushed] = await Promise.all([b.page.waitForEvent('download', { timeout: 30_000 }), accept.click()]);
  check(sha(await saveDownload(pushed, 'hello.txt')) === sha(small), 'pushed file intact');
  await tile.getByText('보냈어요').waitFor({ timeout: 15_000 });
  check(true, 'sender tile shows done');

  // decline
  await tile.locator('input[type=file]').setInputFiles([{ name: 'no.txt', mimeType: 'text/plain', buffer: small }]);
  await b.page.getByRole('alertdialog').getByRole('button', { name: '거절' }).click({ timeout: 20_000 });
  await tile.getByText('거절').waitFor({ timeout: 15_000 });
  check(true, 'decline reaches the sender');

  // ---------- 4. Firefox <-> Chromium ----------
  console.log('4. Firefox <-> Chromium');
  const f = await open(fox, 'F');
  const fName = (await f.page.locator('.my-device .name').innerText()).trim();
  const ftile = a.page.locator('.peer-tile', { hasText: fName });
  await ftile.waitFor({ timeout: 15_000 });
  const medium = randomBytes(8 * 1024 * 1024 + 7);
  await ftile
    .locator('input[type=file]')
    .setInputFiles([{ name: 'medium.bin', mimeType: 'application/octet-stream', buffer: medium }]);
  const faccept = f.page.getByRole('alertdialog').getByRole('button', { name: '받기' });
  await faccept.waitFor({ timeout: 20_000 });
  const [fdl] = await Promise.all([f.page.waitForEvent('download', { timeout: 60_000 }), faccept.click()]);
  check(sha(await saveDownload(fdl, 'medium.bin')) === sha(medium), 'Chromium -> Firefox 8 MB intact');

  // Firefox shares, Chromium receives via link (no password)
  await f.page
    .locator('.composer input[type=file]')
    .setInputFiles([{ name: 'fox.txt', mimeType: 'text/plain', buffer: small }]);
  await f.page.getByRole('button', { name: '공유 시작' }).click();
  const flink = await f.page.getByLabel('공유 링크').inputValue();
  await b.page.goto(flink);
  const [fromFox] = await Promise.all([
    b.page.waitForEvent('download', { timeout: 30_000 }),
    b.page.getByRole('button', { name: '받기', exact: true }).click({ timeout: 20_000 }),
  ]);
  check(sha(await saveDownload(fromFox, 'fox.txt')) === sha(small), 'Firefox -> Chromium via link intact');

  // ---------- 5. resume after a dropped connection ----------
  console.log('5. resume after a dropped connection');
  const hugePath = path.join(out, 'huge.bin');
  const huge = randomBytes(300 * 1024 * 1024 + 11);
  writeFileSync(hugePath, huge);
  const hugeSha = sha(huge);
  const dropAt = async (page, progress, percentAtLeast) => {
    await page.waitForFunction(
      ([selector, min]) => {
        const text = document.querySelector(selector)?.textContent ?? '';
        const value = Number(/(\d+)\s*%/.exec(text)?.[1] ?? 0);
        return value >= min && value < 95;
      },
      [progress, percentAtLeast],
      { timeout: 60_000, polling: 50 },
    );
    // Close every data channel on this side: both ends see the channel close, like a dropped connection.
    await page.evaluate(() => window.__dcs.forEach((dc) => dc.close()));
  };

  // 5a. share link with a password: the receiver reconnects and re-authenticates by itself
  const r1 = await open(chrome, 'R1');
  const r2 = await open(chrome, 'R2');
  await r1.page.locator('.composer input[type=file]').setInputFiles(hugePath);
  await r1.page.getByLabel('비밀번호 사용').check();
  await r1.page.getByPlaceholder('비밀번호', { exact: true }).fill('resume!');
  await r1.page.getByRole('button', { name: '공유 시작' }).click();
  const rlink = await r1.page.getByLabel('공유 링크').inputValue();
  await r2.page.goto(rlink);
  await r2.page.getByPlaceholder('비밀번호').fill('resume!');
  await r2.page.getByRole('button', { name: '확인' }).click();
  const [hugeDownload] = await Promise.all([
    r2.page.waitForEvent('download', { timeout: 60_000 }),
    r2.page.getByRole('button', { name: '받기', exact: true }).click({ timeout: 20_000 }),
  ]);
  await dropAt(r2.page, '.progress-top strong', 15);
  await r2.page.getByText('연결이 끊겼어요').waitFor({ timeout: 15_000 });
  check(true, 'receiver noticed the drop and is reconnecting');
  await r2.page.getByText('받기 완료').waitFor({ timeout: 180_000 });
  check(sha(await saveDownload(hugeDownload, 'huge-share.bin')) === hugeSha, 'share: 300 MB intact after resume');
  check((await r1.page.locator('.receiver').count()) === 1, 'sender shows one receiver row (the reconnect reused it)');
  await r1.context.close();
  await r2.context.close();

  // 5b. nearby push: the sender reconnects, the receiver continues the same download
  const p1 = await open(chrome, 'P1');
  const p2 = await open(chrome, 'P2');
  const p2Name = (await p2.page.locator('.my-device .name').innerText()).trim();
  const ptile = p1.page.locator('.peer-tile', { hasText: p2Name });
  await ptile.waitFor({ timeout: 15_000 });
  await ptile.locator('input[type=file]').setInputFiles(hugePath);
  const paccept = p2.page.getByRole('alertdialog').getByRole('button', { name: '받기' });
  await paccept.waitFor({ timeout: 20_000 });
  const [pushDownload] = await Promise.all([p2.page.waitForEvent('download', { timeout: 60_000 }), paccept.click()]);
  await dropAt(p2.page, '.tray-item .num', 15);
  await ptile.getByText('다시 연결하는 중').waitFor({ timeout: 15_000 });
  check(true, 'sender tile shows reconnecting');
  await ptile.getByText('보냈어요').waitFor({ timeout: 180_000 });
  check(sha(await saveDownload(pushDownload, 'huge-push.bin')) === hugeSha, 'push: 300 MB intact after resume');
  await p1.context.close();
  await p2.context.close();

  // ---------- 6. share listed on the network without a password ----------
  console.log('6. LAN-listed share without a password');
  const l1 = await open(chrome, 'L1');
  const l2 = await open(chrome, 'L2');
  const l3 = await open(chrome, 'L3');
  const l1Name = (await l1.page.locator('.my-device .name').innerText()).trim();
  await l1.page
    .locator('.composer input[type=file]')
    .setInputFiles([{ name: 'lan.txt', mimeType: 'text/plain', buffer: small }]);
  check(!(await l1.page.getByLabel('같은 네트워크에 표시').isChecked()), 'network listing is off by default');
  await l1.page.getByLabel('같은 네트워크에 표시').check();
  await l1.page.getByRole('button', { name: '공유 시작' }).click();
  const lanLink = await l1.page.getByLabel('공유 링크').inputValue();

  // From the list (no link secret): the sender has to approve.
  await l2.page.locator('.share-item', { hasText: `${l1Name}의 파일` }).click({ timeout: 15_000 });
  await l2.page.getByText('보내는 사람의 승인을 기다리는 중').waitFor({ timeout: 20_000 });
  check(true, 'visitor from the list waits for approval');
  await l1.page.locator('.receiver.approval').getByRole('button', { name: '허용' }).click({ timeout: 15_000 });
  const [lanDownload] = await Promise.all([
    l2.page.waitForEvent('download', { timeout: 30_000 }),
    l2.page.getByRole('button', { name: '받기', exact: true }).click({ timeout: 15_000 }),
  ]);
  check(sha(await saveDownload(lanDownload, 'lan.txt')) === sha(small), 'approved visitor gets the file');

  // With the link: no approval.
  await l3.page.goto(lanLink);
  await l3.page.getByRole('button', { name: '받기', exact: true }).waitFor({ timeout: 20_000 });
  check(true, 'link holder skips approval');
  await l1.context.close();
  await l2.context.close();
  await l3.context.close();

  // screenshots for a visual check
  await a.page.goto(base);
  await a.page.locator('.status.online').waitFor();
  await a.page.setViewportSize({ width: 1280, height: 900 });
  await a.page.screenshot({ path: path.join(out, 'home-light.png'), fullPage: true });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await chrome.close();
  await fox.close();
}

const relevant = errors.filter((e) => !/favicon|apple-touch-icon|icon-192|og\.png/.test(e));
check(relevant.length === 0, `no console errors${relevant.length ? `:\n    ${relevant.join('\n    ')}` : ''}`);
writeFileSync(path.join(out, 'errors.txt'), errors.join('\n'));
console.log(`artifacts: ${out}`);
process.exit(failed ? 1 : 0);
