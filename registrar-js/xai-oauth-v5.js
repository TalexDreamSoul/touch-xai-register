#!/usr/bin/env node
// xAI OAuth Auto-Registration v5
// Flow: Create email → Sign up xAI → Login CPA → Trigger OAuth (fresh user_code) → Device auth → Allow → Extract code → Submit to CPA

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ====== CONFIG ======
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DUCKMAIL_API = config.mailBaseUrl || 'https://api.duckmail.sbs';
const DUCKMAIL_KEY = config.duckmailApiKey;
const MANAGEMENT_URL = config.managementUrl || 'http://localhost:18317';
const MANAGEMENT_KEY = config.managementKey;
const REGISTER_PASSWORD = config.registerPassword || 'Aa123456!@';
const CHROME_PATH = config.chromePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const FIRST_NAMES = ['James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles',
    'Mary','Patricia','Jennifer','Linda','Barbara','Elizabeth','Karen','Nancy','Lisa','Jessica','Betty','Sandra'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
    'Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','White','Harris','Clark'];

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ====== MAIL ======
async function createEmail() {
    console.log('[Mail] 创建临时邮箱...');
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DUCKMAIL_KEY}` };

    // Get domain
    const domRes = await fetch(`${DUCKMAIL_API}/domains`, { headers });
    if (!domRes.ok) throw new Error(`Domains API error: ${domRes.status}`);
    const domains = (await domRes.json())['hydra:member'] || [];
    const verified = domains.filter(d => d.isVerified);
    if (!verified.length) throw new Error('No verified domain');
    const domain = verified[0].domain;
    console.log(`    域名: ${domain}`);

    // Generate email
    const emailName = crypto.randomBytes(5).toString('hex');
    const email = `${emailName}@${domain}`;
    const password = crypto.randomBytes(8).toString('hex');

    // Create account
    await fetch(`${DUCKMAIL_API}/accounts`, {
        method: 'POST', headers,
        body: JSON.stringify({ address: email, password, quotas: {} })
    });
    console.log(`    创建: ${email}`);

    // Get token
    const tokenRes = await fetch(`${DUCKMAIL_API}/token`, {
        method: 'POST', headers,
        body: JSON.stringify({ address: email, password })
    });
    const tokenData = await tokenRes.json();
    const jwt = tokenData.token;
    if (!jwt) throw new Error('No JWT');

    return { email, jwt };
}

async function getVerificationCode(emailObj) {
    const { email, jwt } = emailObj;
    try {
        const headers = { 'Authorization': `Bearer ${jwt}` };
        const res = await fetch(`${DUCKMAIL_API}/messages?page=1`, { headers });
        if (!res.ok) return null;
        const data = await res.json();
        const list = data['hydra:member'] || [];
        if (!list.length) return null;

        // Get latest message detail
        const latest = list[0];
        const detailRes = await fetch(`${DUCKMAIL_API}/messages/${latest.id}`, { headers });
        if (!detailRes.ok) return null;
        const detail = await detailRes.json();
        const text = detail.text || detail.html || detail.subject || '';
        const m = text.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3,4})\b/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ====== CAPTCHA HELPER ======
async function waitForCaptcha(page) {
    for (let i = 0; i < 30; i++) {
        await SLEEP(2000);
        const done = await page.evaluate(() => {
            const frames = document.querySelectorAll('iframe[title*="captcha"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]');
            return frames.length === 0 || Array.from(frames).every(f => {
                try { return f.contentDocument?.body?.querySelector?.('.check[aria-checked="true"], [data-hcaptcha-response]'); } catch { return false; }
            });
        });
        if (done) { console.log('    人机验证已通过'); return; }
    }
}

// ====== MANAGEMENT LOGIN ======
async function loginCPA(page) {
    await page.goto(MANAGEMENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await SLEEP(3000);

    // API verification
    const apiOk = await page.evaluate(async key => {
        try {
            const r = await fetch('/v0/management/config', { headers: { 'X-Management-Key': key } });
            return r.ok;
        } catch { return false; }
    }, MANAGEMENT_KEY);
    if (!apiOk) throw new Error('管理密钥无效');
    console.log('    API 验证通过');

    // Form fill
    await page.evaluate(key => {
        const inputs = document.querySelectorAll('input:not([type="checkbox"])');
        const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        for (const inp of inputs) {
            ns.set.call(inp, inp.type === 'password' ? key : 'admin');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const btn = Array.from(document.querySelectorAll('button')).find(b => /Login|登录/i.test(b.innerText));
        if (btn) btn.click();
    }, MANAGEMENT_KEY);
    await SLEEP(5000);
    console.log('    登录完成');
}

// ====== CPA OAUTH TRIGGER ======
async function triggerOAuth(page) {
    await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await SLEEP(5000);

    // Click Start xAI Login
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = btns.find(x => /Start xAI/i.test(x.innerText || x.textContent || ''));
        if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
    });
    await SLEEP(5000);

    // Extract user_code
    let userCode = null;
    for (let i = 0; i < 20; i++) {
        await SLEEP(2000);
        const extracted = await page.evaluate(() => {
            const text = document.body.innerText;
            const m = text.match(/user_code[=:]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
            if (m) return m[1];
            const m2 = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
            return m2 ? m2[1] : null;
        });
        if (extracted) { userCode = extracted; break; }
    }
    if (!userCode) throw new Error('无法提取 user_code');
    console.log(`    user_code: ${userCode}`);
    return userCode;
}

// ====== MAIN ======
async function main() {
    const emailObj = await createEmail();
    const email = emailObj.email;

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: CHROME_PATH,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1600, height: 1200 }
    });

    // ====== PHASE 1: xAI Sign-Up ======
    const xaiPage = await browser.newPage();
    console.log('\n[1] 打开 xAI 注册...');
    await xaiPage.goto('https://accounts.x.ai/sign-up', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await SLEEP(5000);

    // Dismiss cookies first
    await xaiPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const cookieBtn = btns.find(b => /Accept All|Allow All|全部允许/i.test(b.innerText?.trim() || ''));
        if (cookieBtn) cookieBtn.click();
    });
    await SLEEP(3000);

    // Click Sign up with email
    await xaiPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], span'));
        const btn = btns.find(x => /Sign up with email/i.test(x.innerText?.trim() || ''));
        if (btn) btn.click();
    });
    await SLEEP(3000);
    await waitForCaptcha(xaiPage);

    // Input email
    console.log('[2] 输入邮箱...');
    const emailInput = await xaiPage.$('input[name="email"], input[type="email"]');
    if (emailInput) {
        await emailInput.click({ clickCount: 3 });
        for (const ch of email) await emailInput.type(ch, { delay: rand(30, 80) });
    }
    await SLEEP(1500);
    await xaiPage.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => /继续|Continue|Next/i.test(x.innerText?.trim() || ''));
        if (b) b.click();
    });
    await SLEEP(5000);
    await waitForCaptcha(xaiPage);

    // Wait for verification code
    console.log('[3] 等待验证码...');
    let code = null;
    for (let i = 0; i < 60; i++) {
        await SLEEP(5000);
        code = await getVerificationCode(emailObj);
        if (code) break;
        if (i % 6 === 0) console.log(`    轮询 (${i + 1}/60)...`);
    }
    if (!code) { console.log('未收到验证码'); return; }
    console.log(`    验证码: ${code}`);

    // Input code
    const codeInput = await xaiPage.$('input[name="code"]') || (await xaiPage.$$('input'))?.[0];
    if (codeInput) {
        await codeInput.click({ clickCount: 3 });
        for (const ch of code) await codeInput.type(ch, { delay: rand(50, 100) });
    }
    await SLEEP(1000);
    await xaiPage.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => /确认邮箱|Confirm|验证|Verify/i.test(x.innerText?.trim() || ''));
        if (b) b.click();
    });
    await SLEEP(8000);
    await waitForCaptcha(xaiPage);

    // Fill name and password
    const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    console.log(`[4] 填写信息: ${firstName} ${lastName}`);

    const givenInput = await xaiPage.$('input[name="givenName"]');
    if (givenInput) { await givenInput.click({ clickCount: 3 }); for (const ch of firstName) await givenInput.type(ch, { delay: rand(50, 100) }); }
    await SLEEP(500);
    const familyInput = await xaiPage.$('input[name="familyName"]');
    if (familyInput) { await familyInput.click({ clickCount: 3 }); for (const ch of lastName) await familyInput.type(ch, { delay: rand(50, 100) }); }
    await SLEEP(500);
    const pwdInput = await xaiPage.$('input[name="password"]');
    if (pwdInput) { await pwdInput.click({ clickCount: 3 }); for (const ch of REGISTER_PASSWORD) await pwdInput.type(ch, { delay: rand(80, 150) }); }
    await SLEEP(2000);

    // Complete sign-up
    await xaiPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(x => /完成注册|完成|Complete|Create account|Sign up/i.test(x.innerText?.trim() || ''));
        if (btn) btn.click();
    });
    await SLEEP(5000);
    await waitForCaptcha(xaiPage);
    console.log('[5] 注册完成！');

    // ====== PHASE 2: CPA OAuth ======
    const page = await browser.newPage();
    console.log('\n[6] 登录管理页面...');
    await loginCPA(page);

    console.log('[7] 触发 xAI OAuth...');
    const userCode = await triggerOAuth(page);
    const deviceUrl = `https://accounts.x.ai/oauth2/device?user_code=${userCode}`;
    console.log(`    跳转: ${deviceUrl}`);

    // ====== PHASE 3: Device Auth ======
    await xaiPage.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await SLEEP(5000);
    console.log('[8] 等待设备授权页面...');

    for (let i = 0; i < 30; i++) {
        const info = await xaiPage.evaluate(() => ({
            url: location.href,
            text: document.body.innerText.substring(0, 300),
            btns: Array.from(document.querySelectorAll('button')).map(b => b.innerText?.trim()).filter(t => t)
        }));

        if (i < 5) console.log(`    [${i + 1}] ${info.url.substring(0, 60)} BTNS=${info.btns.join(',').substring(0, 80)}`);

        // Check for success
        if (/authorized|success|已授权/i.test(info.text)) {
            console.log('    设备授权成功！');
            break;
        }

        // Dismiss cookies
        const cookieBtn = info.btns.find(b => /Accept.*All|Allow.*All/i.test(b));
        if (cookieBtn && i < 8) {
            await xaiPage.evaluate(bText => {
                const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText?.trim() === bText);
                if (b) b.click();
            }, cookieBtn);
            await SLEEP(2000);
            console.log(`    关闭 Cookie: ${cookieBtn}`);
            continue;
        }

        // Click Continue
        const continueBtn = info.btns.find(b => b === '继续' || b === 'Continue');
        if (continueBtn) {
            await xaiPage.evaluate(bText => {
                const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText?.trim() === bText);
                if (b) b.click();
            }, continueBtn);
            await SLEEP(5000);
            console.log(`    点击: ${continueBtn}`);
            continue;
        }

        // Click Allow
        const allowBtn = info.btns.find(b => b === '允许' || b === 'Allow' || b === 'Authorize' || b === '同意' || b === 'Approve');
        if (allowBtn) {
            await xaiPage.evaluate(bText => {
                const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText?.trim() === bText);
                if (b) b.click();
            }, allowBtn);
            console.log(`    点击: ${allowBtn}`);
            await SLEEP(8000);

            // Check for callback redirect
            const afterAllow = await xaiPage.evaluate(() => ({
                url: location.href,
                text: document.body.innerText.substring(0, 500)
            }));
            console.log(`    Allow后: ${afterAllow.url.substring(0, 80)}`);

            // Extract code
            const cm = afterAllow.url.match(/[?&]code=([^&]+)/);
            if (cm) {
                console.log(`    提取 code: ${cm[1]}`);
                // Submit to CPA
                try {
                    await page.bringToFront();
                    await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await SLEEP(3000);
                    const cbResp = await page.evaluate(async ([code, key]) => {
                        const r = await fetch('/v0/management/oauth-callback', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-Management-Key': key },
                            body: JSON.stringify({ provider: 'xai', code })
                        });
                        return { ok: r.ok, status: r.status, text: await r.text() };
                    }, [cm[1], MANAGEMENT_KEY]);
                    console.log(`    回调: ${cbResp.status} ${cbResp.text.substring(0, 80)}`);
                } catch (e) { console.log(`    回调异常: ${e.message.substring(0, 60)}`); }
            } else {
                console.log(`    页面: ${afterAllow.text.substring(0, 200)}`);
            }
            // Wait and check result
            await SLEEP(20000);
        }

        await SLEEP(4000);
    }

    // ====== PHASE 4: Wait for auth file ======
    console.log('\n[9] 等待认证文件...');
    await page.bringToFront();
    await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await SLEEP(5000);

    for (let i = 0; i < 30; i++) {
        await SLEEP(3000);
        const hasAuth = await page.evaluate(() => {
            const text = document.body.innerText;
            return /xAI.*成功|xai.*token|tds\.kdns/i.test(text);
        });
        if (hasAuth) { console.log('    认证文件获取成功！'); break; }
        console.log(`    等待... (${i + 1}/30)`);
    }

    console.log('\n========================================');
    console.log(`  邮箱: ${email}`);
    console.log('========================================');
    console.log('浏览器保持打开，按 Ctrl+C 退出...');
    await new Promise(() => {});
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
