const { connect } = require('puppeteer-real-browser');
const { MailProvider } = require('./src/mailProvider');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 读取配置文件
let config = {};
try {
    const configPath = path.join(__dirname, 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('无法读取 config.json，请确保文件存在且格式正确');
    process.exit(1);
}

// 配置项
const MANAGEMENT_URL = config.managementUrl || 'http://127.0.0.1:8317';
const MANAGEMENT_KEY = config.managementKey || '123456';
const REGISTER_PASSWORD = config.registerPassword || 'YourP@ssw0rd';
const CHROME_PATH = config.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_USER_DATA_DIR = config.chromeUserDataDir || path.join(os.homedir(), '.xai-registrar', 'chrome-profile');

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

// 随机名姓
const FIRST_NAMES = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White'];
const randomFirstName = () => FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
const randomLastName = () => LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];

// ================================================================
// xAI Device OAuth 自动注册
// ================================================================

function mailToRawText(mail = {}) {
    return [mail.raw, mail.text, mail.content, mail.subject, mail.message]
        .filter(v => typeof v === 'string' && v.trim().length > 0).join('\n');
}

function extractCode(body) {
    if (!body) return null;
    const patterns = [
        /(?:confirmation\s*code|verification\s*code|安全代码|验证码)\s*[：:\s]*([A-Z0-9]{3,4}-[A-Z0-9]{3,4})/i,
        /([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\s*(?:confirmation\s*code|verification\s*code|xAI)/i,
        /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/,
    ];
    for (const p of patterns) {
        const m = body.match(p);
        if (m) {
            const code = m[1];
            if (!/^[0-9a-f]{8}-/.test(code.toLowerCase())) return code;
        }
    }
    for (const m of body.matchAll(/\d{6}/g)) {
        const idx = m.index, code = m[0];
        const prev = body[idx - 1] || '', next = body[idx + 6] || '';
        const ctx = body.slice(Math.max(0, idx - 50), idx + 70).toLowerCase();
        if (prev === '#') continue;
        if (ctx.includes('http') || ctx.includes('href=')) continue;
        if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) continue;
        return code;
    }
    return null;
}

async function pollEmailCode(mailProvider, maxAttempts = 60) {
    for (let a = 1; a <= maxAttempts; a++) {
        console.log(`[Mail] 轮询验证码 (${a}/${maxAttempts})...`);
        try {
            const mails = await mailProvider.getMails(5, 0);
            if (mails.length > 0) {
                const raw = mailToRawText(mails[0]);
                const code = extractCode(raw);
                if (code) { console.log(`[Mail] 收到验证码: ${code}`); return code; }
                console.log(`[Mail] 有邮件但未提取到验证码，内容前200字:`);
                console.log(raw.substring(0, 200));
            }
        } catch (e) { console.error(`[Mail] 查询出错: ${e.message}`); }
        await SLEEP(5000);
    }
    throw new Error('邮箱验证码超时');
}

async function main() {
    console.log('========================================');
    console.log('  xAI OAuth 自动注册');
    console.log('========================================\n');

    // 1. 创建临时邮箱
    console.log('[1] 创建临时邮箱...');
    const mailProvider = new MailProvider({
        baseUrl: config.mailBaseUrl,
        adminPassword: config.mailAdminPassword,
        sitePassword: config.mailSitePassword,
        domain: config.mailDomain,
        provider: config.mailProvider,
        adminEmail: config.mailAdminEmail,
        adminToken: config.mailAdminToken,
        duckmailApiKey: config.duckmailApiKey,
        userType: config.mailUserType,
    });
    await mailProvider.createAddress();
    const email = mailProvider.getEmail();
    console.log(`    邮箱: ${email}`);

    // 2. 启动浏览器（puppeteer-real-browser）
    console.log('\n[2] 启动浏览器...');
    fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true });
    const { page: mainPage, browser } = await connect({
        headless: false,
        turnstile: true,
        args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--start-maximized'],
        customConfig: {
            chromePath: CHROME_PATH,
            userDataDir: CHROME_USER_DATA_DIR,
        },
        connectOption: { defaultViewport: null },
    });
    let page = await browser.newPage();
    await page.bringToFront();
    await page.setViewport({ width: 1280, height: 900 });
    console.log(`    浏览器已启动: ${CHROME_PATH}`);

    // 3. 登录管理页面
    console.log(`\n[3] 登录管理页面 (${MANAGEMENT_URL})...`);
    await page.goto(MANAGEMENT_URL + '/management.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await SLEEP(5000);

    let stillOnLogin = await page.evaluate(() => location.href.includes('login'));
    if (stillOnLogin) {
        // 先通过 API 验证密钥
        const apiOk = await page.evaluate(async (key) => {
            const r = await fetch('/v0/management/config', { headers: { 'X-Management-Key': key } });
            return r.ok;
        }, MANAGEMENT_KEY);
        if (!apiOk) throw new Error('管理密钥无效');
        console.log('    API 验证通过');

        // 用原生 setter 填充表单（Run 1 验证通过的方式）
        const formDone = await page.evaluate((key) => {
            const inputs = document.querySelectorAll('input:not([type="checkbox"])');
            let found = false;
            for (const inp of inputs) {
                const nm = (inp.name || inp.placeholder || '').toLowerCase();
                if (nm.includes('key') || nm.includes('management')) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(inp, key);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    found = true;
                    break;
                }
            }
            if (!found) return false;
            // 点击登录按钮
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (/登录|Login/i.test(b.innerText.trim())) {
                    b.click();
                    return true;
                }
            }
            return false;
        }, MANAGEMENT_KEY);
        console.log(`    表单提交: ${formDone}`);
        await SLEEP(12000);
    }

    // 管理 SPA 初始化错误不中断流程
    page.on('pageerror', err => console.log('    [SPA]', err.message.substring(0, 80)));
    page.on('console', msg => { if (msg.type() === 'error') console.log('    [SPA:console]', msg.text().substring(0, 80)); });
    // 直接跳 OAuth 页面，等 SPA 加载
    // 防止 SPA 慢性崩溃：提前 patch innerText 访问
    await page.evaluateOnNewDocument(() => {
        const origDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
        if (origDesc && origDesc.get) {
            const origGet = origDesc.get;
            Object.defineProperty(HTMLElement.prototype, 'innerText', {
                get() { try { return origGet.call(this); } catch (e) { return this.textContent || ''; } },
                set(v) { origDesc.set.call(this, v); },
                configurable: true, enumerable: true
            });
        }
    });
    console.log('\n[4] 跳转到 OAuth 页面（等待 SPA 初始化）...');
    try { await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 120000 }); } catch (e) { console.log('    页面警告:', e.message.substring(0, 80)); }
    await SLEEP(20000);

    // 忽略 SPA 内部错误
    await page.evaluate(() => { window.onerror = () => true; });

    // 点击 xAI OAuth 按钮
    let btnText = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        await SLEEP(2000);
        try {
            btnText = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b && b.innerText && (b.innerText.trim() === 'Start xAI Login' || b.innerText.trim() === '开始 xAI 登录'));
                if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return btn.innerText.trim(); }
                return null;
            });
        } catch (e) { /* SPA might have errors, ignore */ }
        if (btnText) break;
        console.log(`    等待 xAI 按钮... (${attempt + 1}/10)`);
    }
    console.log(`    xAI 按钮: ${btnText || '未找到'}`);

    let userCode = null;
    let authUrl = null;

    // 重试机制：最多 3 次点击 + 提取
    for (let retry = 0; retry < 3 && !userCode; retry++) {
        try {
            if (retry > 0) {
                console.log(`    未提取到 user_code，重试 (${retry + 1}/3)...`);
                await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 120000 });
                await SLEEP(8000);
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const btn = btns.find(b => b.innerText && (b.innerText.trim() === 'Start xAI Login' || b.innerText.trim() === '开始 xAI 登录'));
                    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
                });
                await SLEEP(8000);
            }

            for (let i = 0; i < 20; i++) {
                await SLEEP(2000);
                const extracted = await page.evaluate(() => {
                    const text = document.body.innerText;
                    const urlMatch = text.match(/https?:\/\/accounts\.x\.ai\/[^\s]+user_code=([A-Z0-9]{4}-[A-Z0-9]{4})[^\s]*/i);
                    if (urlMatch) return { userCode: urlMatch[1], authUrl: urlMatch[0] };
                    const ucMatch = text.match(/user_code[=:]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
                    if (ucMatch) return { userCode: ucMatch[1] };
                    const m = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
                    return m ? { userCode: m[1] } : null;
                });
                if (extracted?.userCode) {
                    userCode = extracted.userCode;
                    authUrl = extracted.authUrl || null;
                    console.log(`    提取到 user_code: ${userCode}`);
                    if (authUrl) console.log(`    授权链接: ${authUrl}`);
                    break;
                }
                if (i === 0 && retry === 0) {
                    const dbg = await page.evaluate(() => document.body.innerText.substring(0, 1000));
                    console.log('    [DEBUG] 页面文本前1000字:');
                    console.log(dbg);
                }
                console.log(`    等待授权链接... (${i + 1}/20)`);
            }
        } catch (e) { console.log('    提取异常:', e.message.substring(0, 60)); }
    }

    if (!userCode) throw new Error('无法获取 user_code 或授权链接');
    const xaiTargetUrl = authUrl || `https://accounts.x.ai/oauth2/device?user_code=${userCode}`;

    // 5. 在新标签页打开 xAI device 页面
    console.log('\n[5] 新开标签页打开 xAI device 页面...');
    const xaiPage = await browser.newPage();
    await xaiPage.goto(xaiTargetUrl, {
        waitUntil: 'domcontentloaded', timeout: 120000,
    });
    await SLEEP(10000);

    // 检测 rate_limited
    const xaiUrl = xaiPage.url();
    if (xaiUrl.includes('rate_limited') || xaiUrl.includes('error=')) {
        console.log('    xAI 频率限制！等待 5 分钟...');
        await SLEEP(300000);
        await xaiPage.goto(xaiTargetUrl, {
            waitUntil: 'domcontentloaded', timeout: 120000,
        });
        await SLEEP(10000);
    }

    // 辅助：检测人机验证
    async function waitForCaptcha(targetPage, timeoutMs = 120000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const hasCaptcha = await targetPage.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                const hasTurnstile = !!document.querySelector('[class*="turnstile"], [id*="turnstile"], iframe[src*="cloudflare"]');
                const hasCaptchaText = /人机验证|验证您是|are you human|captcha/i.test(text);
                return hasTurnstile || hasCaptchaText;
            });
            if (!hasCaptcha) { console.log('    人机验证已通过'); return true; }
            console.log('    等待人机验证...');
            await SLEEP(5000);
        }
        return false;
    }

    await waitForCaptcha(xaiPage);

    // 输入 user_code
    const codeInput = await xaiPage.$('input');
    if (codeInput) { await codeInput.click({ clickCount: 3 }); await codeInput.type(userCode, { delay: 60 }); }
    await xaiPage.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /继续|Continue/.test(x.innerText)); if (b) b.click(); });
    // 如果是注册流程（非登录），先在这里注册完成
    // 流程：账号已注册 → 继续到 device 页面自动确认 → 切回管理页重新获取 user_code
    let needReauth = false;
    await SLEEP(8000);
    await waitForCaptcha(xaiPage);

    // x.com cookie 弹窗处理
    const onXcom = await xaiPage.evaluate(() => location.hostname.includes('x.com'));
    if (onXcom) {
        console.log('    检测到 x.com 跳转，处理 cookie 弹窗...');
        await xaiPage.evaluate(() => {
            // 点 "Accept all cookies" 或 "Refuse"
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const accept = btns.find(b => /accept all|允许所有|accept.*cookies|refuse/i.test(b.innerText || b.textContent || ''));
            if (accept) { accept.click(); return 'accepted'; }
            return 'no cookie button found';
        }).then(r => console.log(`    cookie: ${r}`));
        await SLEEP(3000);
    }

    const pageUrlNow = await xaiPage.evaluate(() => location.href);
    console.log(`    当前页面: ${pageUrlNow.substring(0, 80)}`);

    // 检查是否在 x.com 授权页面上
    const onXauth = await xaiPage.evaluate(() => location.href.includes('oauth2/authorize'));
    if (onXauth) {
        console.log('    x.com OAuth 授权页面，查找注册入口...');
        const signResult = await xaiPage.evaluate(() => {
            const body = document.body.innerText.substring(0, 300);
            const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
            const signLink = links.find(l => /sign up|create account|注册/i.test((l.innerText || l.textContent || '').trim()));
            if (signLink) { signLink.click(); return 'clicked: ' + signLink.innerText?.trim(); }
            if (/email|sign up/i.test(body)) return 'already on sign-up';
            return 'not found: ' + body.substring(0, 100);
        });
        console.log(`    x.com: ${signResult}`);
        await SLEEP(5000);
    }

    // 使用邮箱注册
    console.log('\n[6] 使用邮箱注册...');
    await xaiPage.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /使用邮箱|邮箱注册|email|Sign\s*up/i.test(x.innerText.trim())); if (b) b.click(); });
    await SLEEP(8000);

    // 输入邮箱
    console.log(`[7] 输入邮箱: ${email}`);
    const emailInput = await xaiPage.$('input[name="email"]') || await xaiPage.$('input[type="email"]');
    if (emailInput) {
        const box = await emailInput.boundingBox();
        if (box) { await xaiPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await SLEEP(300); await xaiPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
        await SLEEP(500);
        await emailInput.type(email, { delay: 80 + Math.random() * 150 });
    }
    await SLEEP(1000 + Math.random() * 1000);

    const registerBtnPos = await xaiPage.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => /注册|继续|Continue|Sign\s*up|Next/i.test(x.innerText.trim()));
        if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (registerBtnPos) { await xaiPage.mouse.move(registerBtnPos.x, registerBtnPos.y, { steps: 8 }); await SLEEP(500); await xaiPage.mouse.click(registerBtnPos.x, registerBtnPos.y); }
    await SLEEP(5000);

    // 检测是否跳到了登录页（有密码框 + Sign up 链接），需要先点 Sign up
    const isOnLoginPage = await xaiPage.evaluate(() => {
        const hasPwd = !!document.querySelector('input[type="password"]');
        const hasSignUp = Array.from(document.querySelectorAll('a, button, [role="button"]'))
            .some(el => /sign\s*up/i.test((el.innerText || el.textContent || '').trim()));
        return hasPwd && hasSignUp;
    });
    if (isOnLoginPage) {
        console.log('    检测到登录页，点 Sign up 进入注册...');
        await xaiPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
            const signUp = links.find(l => /sign\s*up/i.test((l.innerText || l.textContent || '').trim()));
            if (signUp) signUp.click();
        });
        await SLEEP(5000);
    }

    // 检测是否在注册方法选择页（Sign up with email）
    const isMethodPage = await xaiPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        return btns.some(b => /sign up with email/i.test((b.innerText || b.textContent || '').trim()));
    });
    if (isMethodPage) {
        console.log('    点击 "Sign up with email"...');
        await xaiPage.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const emailBtn = btns.find(b => /sign up with email/i.test((b.innerText || b.textContent || '').trim()));
            if (emailBtn) emailBtn.click();
        });
        await SLEEP(5000);
        await waitForCaptcha(xaiPage);
    }

    // 如果还在注册页且又有 email 输入框，再填一次（xAI sign-in → sign-up 要填两次）
    const emailAgain = await xaiPage.$('input[name="email"]') || await xaiPage.$('input[type="email"]');
    if (emailAgain) {
        console.log('    注册页再次输入邮箱...');
        const eBox = await emailAgain.boundingBox();
        if (eBox) { await xaiPage.mouse.move(eBox.x + eBox.width / 2, eBox.y + eBox.height / 2); await SLEEP(300); await xaiPage.mouse.click(eBox.x + eBox.width / 2, eBox.y + eBox.height / 2); }
        await SLEEP(500);
        await emailAgain.type(email, { delay: 80 + Math.random() * 150 });
        await SLEEP(500);
        // 点击 Sign up 按钮
        const signUpBtn = await xaiPage.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => /Sign\s*up/i.test(x.innerText.trim()));
            if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (signUpBtn) { await xaiPage.mouse.move(signUpBtn.x, signUpBtn.y, { steps: 8 }); await SLEEP(500); await xaiPage.mouse.click(signUpBtn.x, signUpBtn.y); }
        await SLEEP(5000);
    }

    await SLEEP(5000);
    await waitForCaptcha(xaiPage);
    // 验证码页面
    console.log('\n[8] 等待验证码页面...');
    let onVerifyPage = false;
    for (let i = 0; i < 30; i++) {
        await SLEEP(3000);
        const info = await xaiPage.evaluate(() => ({
            url: location.href, text: document.body.innerText.substring(0, 500),
            inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(inp => ({ name: inp.name, type: inp.type, placeholder: inp.placeholder || '' })),
        }));
        const codeField = info.inputs.find(inp => inp.name === 'code');
        const isCodePage = /验证您的邮箱|verify your email|安全代码|security code|check your email|enter.*code|输入.*码|we.*sent|已发送/i.test(info.text);
        if (codeField && isCodePage) { onVerifyPage = true; console.log('    验证码页面已就绪'); break; }
        // 即使没有 code 输入框，也尝试进入验证码模式
        if (isCodePage && info.inputs.length === 0) { console.log('    等待验证码输入框出现...'); }
        if (info.inputs.find(inp => inp.name === 'givenName')) { console.log('    跳过验证码，直接到名/姓页面'); break; }
        if (i === 0 || i === 5 || i === 10) console.log(`    [${i + 1}/30] URL=${info.url} TEXT=${info.text.substring(0, 150)}`);
        else console.log(`    等待中... (${i + 1}/30)`);
    }

    if (onVerifyPage) {
        console.log('\n[9] 从邮箱获取验证码...');
        try {
            const code = await pollEmailCode(mailProvider);
            const codeInput2 = await xaiPage.$('input[name="code"]');
            if (codeInput2) {
                const box = await codeInput2.boundingBox();
                if (box) { await xaiPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await SLEEP(300); await xaiPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
                await SLEEP(500);
                await codeInput2.type(code, { delay: 100 + Math.random() * 200 });
                console.log('    验证码已输入');
            }
            await SLEEP(2000 + Math.random() * 2000);
            await waitForCaptcha(xaiPage);

            console.log('[10] 点击确认邮箱...');
            const confirmBox = await xaiPage.evaluate(() => {
                const b = Array.from(document.querySelectorAll('button')).find(x => /确认邮箱|Confirm|验证|Verify/.test(x.innerText.trim()));
                if (!b) return null; const rect = b.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            });
            if (confirmBox) { await xaiPage.mouse.move(confirmBox.x, confirmBox.y, { steps: 10 }); await SLEEP(500); await xaiPage.mouse.click(confirmBox.x, confirmBox.y); }
            await SLEEP(10000);
        } catch (e) { console.error('    验证码获取失败:', e.message); }
    }

    // 名/姓/密码页面
    console.log('\n[11] 填写名/姓/密码...');
    let profileFilled = false;
    let cookieAttempts = 0;

    for (let i = 0; i < 40; i++) {
        let info = { url: '', text: '', inputs: [], btns: [] };
        try {
            info = await xaiPage.evaluate(() => ({
                url: location.href, text: document.body.innerText.substring(0, 500),
                inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(inp => inp.offsetParent !== null).map(inp => ({ name: inp.name, type: inp.type })),
                btns: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t),
            }));
        } catch (e) { console.log(`    页面跳转中...`); continue; }
        if (profileFilled && i < 33) console.log(`    等待(${i + 1}/40): URL=${info.url.substring(0, 60)}, BTNS=${info.btns.join(', ').substring(0, 80)}`);

        // 检测 device code 输入页面（已登录但需要输入 code）
        if (/Enter the code|输入.*代码|enter.*code/i.test(info.text)) {
            const codeInputOnDevice = await xaiPage.$('input:not([type="hidden"])');
            if (codeInputOnDevice) {
                const codeToEnter = new URL(info.url).searchParams.get('user_code') || userCode;
                console.log(`    输入 user_code: ${codeToEnter}`);
                await xaiPage.evaluate(code => {
                    const inputs = document.querySelectorAll('input:not([type="hidden"])');
                    const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                    for (const inp of inputs) { ns.set.call(inp, code); inp.dispatchEvent(new Event('input', { bubbles: true })); }
                }, codeToEnter);
                await SLEEP(500);
                await xaiPage.evaluate(() => {
                    const b = Array.from(document.querySelectorAll('button')).find(x => /继续|Continue/.test(x.innerText));
                    if (b) b.click();
                });
                await SLEEP(5000);
                await waitForCaptcha(xaiPage);
                continue;
            }
        }

        if (/设备已授权|授权成功|device.*authorized|success/i.test(info.text)) { console.log('    xAI 注册流程完成！'); break; }

        const hasGivenName = info.inputs.find(inp => inp.name === 'givenName');
        const hasPassword = info.inputs.find(inp => inp.type === 'password');

        if (hasGivenName && hasPassword && !profileFilled) {
            const firstName = randomFirstName();
            const lastName = randomLastName();
            console.log(`    名: ${firstName}, 姓: ${lastName}`);

            // 填名
            const givenInput = await xaiPage.$('input[name="givenName"]');
            if (givenInput) {
                const gBox = await givenInput.boundingBox();
                if (gBox) { await xaiPage.mouse.move(gBox.x + gBox.width / 2, gBox.y + gBox.height / 2); await SLEEP(300); await xaiPage.mouse.click(gBox.x + gBox.width / 2, gBox.y + gBox.height / 2); }
                for (const ch of firstName) await givenInput.type(ch, { delay: 80 + Math.random() * 150 });
            }
            await SLEEP(500);

            // 填姓
            const familyInput = await xaiPage.$('input[name="familyName"]');
            if (familyInput) {
                const fBox = await familyInput.boundingBox();
                if (fBox) { await xaiPage.mouse.move(fBox.x + fBox.width / 2, fBox.y + fBox.height / 2); await SLEEP(300); await xaiPage.mouse.click(fBox.x + fBox.width / 2, fBox.y + fBox.height / 2); }
                for (const ch of lastName) await familyInput.type(ch, { delay: 80 + Math.random() * 150 });
            }
            await SLEEP(500);

            // 填密码
            const pwdInput = await xaiPage.$('input[name="password"]');
            if (pwdInput) {
                const pBox = await pwdInput.boundingBox();
                if (pBox) { await xaiPage.mouse.move(pBox.x + pBox.width / 2, pBox.y + pBox.height / 2); await SLEEP(300); await xaiPage.mouse.click(pBox.x + pBox.width / 2, pBox.y + pBox.height / 2); }
                for (const ch of REGISTER_PASSWORD) await pwdInput.type(ch, { delay: 100 + Math.random() * 200 });
            }
            await SLEEP(1500);
            console.log('    名/姓/密码已填完');

            console.log('    点击完成注册...');
            await xaiPage.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(x => /完成注册|完成|Complete|Finish|Create account|Sign up|Create/i.test(x.innerText.trim()));
                if (btn) btn.click();
            });
            await SLEEP(5000);
            await waitForCaptcha(xaiPage, 60000);
            profileFilled = true;
        }

        // Cookie 弹窗（最多 10 次，避免死循环）
        if (profileFilled && cookieAttempts < 3) {
            const cookiePos = await xaiPage.evaluate(() => {
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
                const btn = allBtns.find(b => {
                    const t = (b.innerText || b.textContent || '').trim();
                    return /Accept All Cookies|Accept all/i.test(t);
                });
                if (!btn) { const names = allBtns.map(b => (b.innerText || b.textContent || '').trim()).filter(t => t); return { found: false, btns: names }; }
                const r = btn.getBoundingClientRect(); return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
            if (cookiePos.found) { cookieAttempts++; console.log(`    关闭 Cookie (${cookieAttempts}/10)...`); await xaiPage.mouse.click(cookiePos.x, cookiePos.y); await SLEEP(3000); continue; }
            else if (i < 3) console.log(`    Cookie候选: ${cookiePos.btns.join(', ').substring(0, 100)}`);
        }

        if (profileFilled) {
            const continueBtn = info.btns.find(b => b === '继续' || b === 'Continue' || b === 'Complete sign up');
            if (continueBtn) {
                console.log(`    点击: ${continueBtn}`);
                const pos = await xaiPage.evaluate(t => { const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.trim() === t); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, continueBtn);
                if (continueBtn === 'Continue' && i > 15) {
                    const dbgAfter = await xaiPage.evaluate(() => ({ url: location.href.substring(0, 80), text: document.body.innerText.substring(0, 300) }));
                    console.log(`    继续后: ${dbgAfter.url} ${dbgAfter.text.replace(/\\n/g,' ').substring(0,150)}`);
                }
                if (pos) { await xaiPage.mouse.click(pos.x, pos.y); }
                await SLEEP(5000);
                continue;
            }
        }

        // "允许"按钮（cookie 已处理后才检查）
        if (profileFilled) {
            const agreeResult = await xaiPage.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                const btn = btns.find(x => { const t = (x.innerText || x.textContent || '').trim(); return t === '允许' || t === 'Authorize' || t === 'Allow' || t === 'Accept' || t === '同意' || t === 'Approve'; });
                if (!btn) return null;
                btn.click();
                return btn.innerText.trim();
            });
            if (agreeResult) {
                console.log(`    点击: ${agreeResult}`);
                cookieAttempts = 0;
                await SLEEP(10000);
                const postAllowUrl = await xaiPage.evaluate(() => location.href);
                const postAllowText = await xaiPage.evaluate(() => document.body.innerText.substring(0, 500));
                console.log(`    Allow后URL: ${postAllowUrl.substring(0, 80)}`);

                if (postAllowText.includes('Invalid')) {
                    console.log('    检测到 Invalid action, 重新获取 user_code...');
                    // 关闭旧 page，开新 page 强制新 OAuth 会话
                    await page.close().catch(() => {});
                    const newPage = await browser.newPage();
                    await newPage.setViewport({ width: 1600, height: 1200 });
                    await newPage.goto(MANAGEMENT_URL + '/management.html#/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await SLEEP(3000);
                    // Re-login
                    await newPage.evaluate(key => {
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
                    await newPage.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await SLEEP(5000);
                    // Click Start xAI Login
                    await newPage.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                        const btn = btns.find(x => /Start xAI/i.test(x.innerText || x.textContent || ''));
                        if (btn) btn.click();
                    });
                    await SLEEP(5000);
                    const freshCode = await newPage.evaluate(() => {
                        const text = document.body.innerText;
                        const m = text.match(/user_code[:\s=]*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
                        if (m) return m[1];
                        const m2 = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
                        return m2 ? m2[1] : null;
                    });
                    if (freshCode) {
                        console.log(`    新 user_code: ${freshCode}`);
                        // Update global page reference
                        page = newPage;
                        await xaiPage.goto(`https://accounts.x.ai/oauth2/device?user_code=${freshCode}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await SLEEP(3000);
                        cookieAttempts = 0;
                    } else {
                        console.log('    无法获取新 user_code');
                    }
                    continue;
                }

                // 提取回调 code
                const cm = postAllowUrl.match(/[?&]code=([^&]+)/);
                const cbCode = cm ? cm[1] : null;
                if (cbCode) {
                    console.log(`    提取到code: ${cbCode}`);
                    try {
                        await page.bringToFront();
                        await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await SLEEP(3000);
                        const cbResp = await page.evaluate(async (code) => {
                            const r = await fetch('/v0/management/oauth-callback', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ provider: 'xai', code })
                            });
                            return { ok: r.ok, status: r.status, text: await r.text() };
                        }, cbCode);
                        console.log(`    回调结果: ${cbResp.status} ${cbResp.text.substring(0, 80)}`);
                    } catch (e) { console.log(`    提交失败: ${e.message.substring(0, 80)}`); }
                } else {
                    console.log(`    页面文本: ${postAllowText.substring(0, 200).replace(/\\n/g, ' ')}`);
                }
                continue;
            }
        }
        await SLEEP(4000);
    }
    console.log('\n[12] 切回管理页面，等待 OAuth 结果...');
    await page.bringToFront();
    await page.goto(MANAGEMENT_URL + '/management.html#/oauth', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await SLEEP(5000);
    // 点击侧边栏 Auth Files
    await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, [role="link"], span, div'));
        const authLink = links.find(l => /Auth Files|auth files/i.test((l.innerText || l.textContent || '').trim()));
        if (authLink) authLink.click();
    });
    await SLEEP(5000);
    for (let i = 0; i < 60; i++) {
        await SLEEP(3000);
        try {
            const text = await page.evaluate(() => document.body.innerText.substring(0, 1000));
            if (/xAI.*成功|xAI.*token|auth.*file.*xai|xai.*oauth.*complete/i.test(text)) { console.log('    OAuth 认证文件获取成功！'); break; }
            if (i === 0) console.log(`    页面: ${text.substring(0, 200)}`);
            console.log(`    等待刷新... (${i + 1}/60)`);
        } catch (e) { console.log(`    ... (${i + 1}/60)`); }
    }

    console.log('\n========================================');
    console.log('  邮箱:', email);
    console.log('========================================\n');
    console.log('浏览器保持打开，按 Ctrl+C 退出...');
    await new Promise(() => {});
}


main().catch(e => { console.error('Error:', e.message); process.exit(1); });
