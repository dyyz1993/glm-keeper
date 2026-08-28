import fs from 'fs';
import path from 'path';
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import { config } from '../config.js';
import { accountStore } from './account-store.js';
import { oplog } from './oplog.js';
import type { Account, FlowState } from '../types.js';

/**
 * bigmodel 实测选择器（2026-08，来自 browser-manager 实战）
 */
export const SEL = {
  phoneInput: ['input[placeholder="请输入手机号"]'],
  accountTab: ['.el-tabs__item:has-text("账号登录")', 'text=账号登录'],
  accountUserInput: ['input[placeholder="请输入用户名/邮箱/手机号"]'],
  accountPwdInput: ['input[placeholder="请输入密码"]'],
  loginBtn: ['button.login-btn:visible', 'button.login-btn', 'button:has-text("登录")'],
  /** 腾讯防水墙滑块弹窗根节点（关闭时离屏隐藏） */
  captcha: ['.tencent-captcha-dy__content', 'iframe[src*="captcha"]'],
  /** 账号设置页「双重认证」行内开关（Element Plus el-switch） */
  twofaRow: ['.common-info:has-text("双重认证")', 'div:has-text("双重认证")'],
  twofaSwitch: ['[role="switch"].el-switch', '.el-switch'],
  /** 2FA 开关确认弹窗按钮 */
  confirmBtn: ['button.confirm-btn', 'button:has-text("确认")', 'button:has-text("确定")'],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(flow: FlowState, msg: string): void {
  flow.logs.push({ time: new Date().toISOString(), msg });
  if (flow.logs.length > 150) flow.logs.splice(0, flow.logs.length - 150);
  console.log(`[Keeper] ${msg}`);
}

function step(flow: FlowState, key: string, text: string): void {
  flow.step = key;
  flow.stepText = text;
}

// ===== 浏览器生命周期 =====

export async function withAccountBrowser<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const dir = path.join(config.profilesDir, accountId);
  fs.mkdirSync(dir, { recursive: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(dir, {
    headless: false, // 滑块需要人工
    channel: 'chrome',
    executablePath: config.chromePath,
    viewport: null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=760,900',
    ],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ===== 滑块（人工协助）— 移植 browser-manager 实战版 =====

/** 滑块「真实可见」检测：与视口有交集 + 尺寸≥60 + 非隐藏样式（离屏常驻容器无交集会被排除） */
async function isCaptchaVisible(page: Page): Promise<boolean> {
  return page.evaluate((selectors: string[]) => {
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 60 || rect.height < 60) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') continue;
        if (rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
          return true;
        }
      }
    }
    return false;
  }, SEL.captcha);
}

/** 等滑块被人工完成（出现 → 等消失）；连续失败≥3次（30s+）提前抛错 */
async function waitForCaptchaSolved(page: Page, flow: FlowState): Promise<boolean> {
  if (!(await isCaptchaVisible(page))) return false;
  log(flow, '🟡 检测到腾讯滑块，请在浏览器窗口中手动完成...');
  step(flow, 'slider', '⏳ 等待人工完成滑块验证（请到浏览器窗口拖动）');
  const startTime = Date.now();
  let errSeen = 0;
  const deadline = Date.now() + config.keeper.captchaTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!(await isCaptchaVisible(page))) {
      log(flow, '滑块验证已通过');
      return true;
    }
    const errText = await page
      .locator('.tencent-captcha-dy__verify-status-area')
      .first()
      .textContent()
      .catch(() => null);
    if (errText && (errText.includes('验证错误') || errText.includes('失败'))) {
      errSeen++;
      if (errSeen >= 3 && Date.now() - startTime > 30_000) {
        throw new Error('滑块多次验证失败（疑似风控）');
      }
    }
  }
  throw new Error('等待人工完成滑块超时（3 分钟）');
}

/** 短暂观察滑块是否弹出（登录场景不保证有）：有→等人工；没有→直接过 */
async function waitForCaptchaOptional(page: Page, flow: FlowState): Promise<void> {
  const watchDeadline = Date.now() + 12_000;
  while (Date.now() < watchDeadline) {
    if (await isCaptchaVisible(page)) {
      await waitForCaptchaSolved(page, flow);
      return;
    }
    await sleep(1500);
  }
  log(flow, '未出现滑块，继续...');
}

/** 关键点击前：滑块若已弹出先等人工 */
export async function ensureNoCaptcha(page: Page, flow: FlowState): Promise<void> {
  if (await isCaptchaVisible(page)) {
    await waitForCaptchaSolved(page, flow);
  }
}

// ===== 通用元素操作 =====

async function mustFindInput(page: Page, selectors: string[], what: string) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
  }
  throw new Error(`未找到${what}`);
}

async function mustFindClickable(page: Page, selectors: string[], what: string) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      if (!(await loc.isEnabled().catch(() => false))) continue;
      return loc;
    }
  }
  throw new Error(`未找到可点击的${what}`);
}

async function clickFirst(page: Page, selectors: string[], what: string): Promise<void> {
  const el = await mustFindClickable(page, selectors, what);
  await el.click({ timeout: 8000 });
}

// ===== 登录态（token）读写 =====

/** 当前页面是否处于已登录状态（在设置页前提下：不在 /login 且无手机号输入框） */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/login')) return false;
  for (const sel of SEL.phoneInput) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return false;
  }
  return true;
}

/** 读取 token cookie（httpOnly=false 可直接读） */
export async function readToken(page: Page): Promise<string | null> {
  const prefix = `${config.bigmodel.tokenCookie}=`;
  const hit = (await page.evaluate(() => document.cookie))
    .split('; ')
    .find((c) => c.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** 删除 token cookie（触发重新登录）。必须带 domain 属性否则不生效（实测） */
export async function deleteToken(page: Page): Promise<void> {
  await page.evaluate(
    ({ name, domain }) => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain}`;
    },
    { name: config.bigmodel.tokenCookie, domain: config.bigmodel.tokenCookieDomain }
  );
}

/** 塞回备份 token 恢复登录态（7 天窗口内有效，实测可恢复） */
export async function injectToken(page: Page, token: string): Promise<void> {
  const exp = new Date(Date.now() + config.keeper.tokenLifeDays * 86400_000).toUTCString();
  await page.evaluate(
    ({ name, domain, value, expires }) => {
      document.cookie = `${name}=${value}; path=/; domain=${domain}; expires=${expires}`;
    },
    { name: config.bigmodel.tokenCookie, domain: config.bigmodel.tokenCookieDomain, value: token, expires: exp }
  );
}

// ===== 双重认证开关 =====

/** 读取双重认证当前状态（true=开 / false=关 / null=找不到行） */
export async function read2FA(page: Page): Promise<boolean | null> {
  return page.evaluate((rowSel: string[]) => {
    for (const sel of rowSel) {
      for (const row of Array.from(document.querySelectorAll(sel))) {
        if (!row.textContent || !row.textContent.includes('双重认证')) continue;
        if (!(row as HTMLElement).offsetWidth && !(row as HTMLElement).offsetHeight) continue;
        const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (input) return input.checked;
        const sw = row.querySelector('.el-switch');
        if (sw) return sw.classList.contains('is-checked');
      }
    }
    return null;
  }, SEL.twofaRow);
}

/** 把双重认证切到目标状态（点击开关 → 可能弹确认/滑块 → 复核） */
export async function set2FA(page: Page, enable: boolean, flow: FlowState): Promise<void> {
  const target = enable ? '开启' : '关闭';
  let current = await read2FA(page);
  if (current === null) throw new Error('设置页未找到「双重认证」行');
  if (current === enable) {
    log(flow, `双重认证已经是${target}状态`);
    return;
  }
  step(flow, `twofa-${enable ? 'on' : 'off'}`, `${target}双重认证...`);
  // 点击该行内的开关
  const clicked = await page.evaluate((rowSel: string[]) => {
    for (const sel of rowSel) {
      for (const row of Array.from(document.querySelectorAll(sel))) {
        if (!row.textContent || !row.textContent.includes('双重认证')) continue;
        if (!(row as HTMLElement).offsetWidth && !(row as HTMLElement).offsetHeight) continue;
        const sw = row.querySelector('[role="switch"], .el-switch__core, .el-switch');
        if (sw) {
          (sw as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, SEL.twofaRow);
  if (!clicked) throw new Error('未找到双重认证开关');
  await sleep(1500);

  // 可能弹出确认对话框
  for (const sel of SEL.confirmBtn) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1000);
      break;
    }
  }
  // 开关过程可能要求滑块
  await ensureNoCaptcha(page, flow);
  await sleep(1000);

  current = await read2FA(page);
  if (current !== enable) {
    throw new Error(`双重认证${target}失败（当前仍为${current === true ? '开' : '关'}）`);
  }
  log(flow, `✅ 双重认证已${target}`);
}

// ===== 密码登录（用户名，不用手机号） =====

export async function passwordLogin(
  page: Page,
  username: string,
  password: string,
  flow: FlowState,
  phone?: string
): Promise<void> {  step(flow, 'login', `用户名+密码登录（${username}）...`);
  await ensureNoCaptcha(page, flow);
  await clickFirst(page, SEL.accountTab, '「账号登录」tab');
  await sleep(800);
  const u = await mustFindInput(page, SEL.accountUserInput, '用户名输入框');
  await u.fill('');
  await u.fill(username);
  const p = await mustFindInput(page, SEL.accountPwdInput, '密码输入框');
  await p.fill('');
  await p.fill(password);
  await ensureNoCaptcha(page, flow);
  const btn = await mustFindClickable(page, SEL.loginBtn, '「登录」按钮');
  await btn.click({ timeout: 10_000 });
  await waitForCaptchaOptional(page, flow);

  const deadline = Date.now() + config.keeper.loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!page.url().includes('/login')) {
      log(flow, '✅ 登录成功');
      return;
    }
    // 检测双重认证二次验证拦截（密码对但要求短信二次验证）
    const hit2fa = await page
      .evaluate(() => {
        const t = document.body.innerText || '';
        return /双重认证|二次验证|安全验证/.test(t);
      })
      .catch(() => false);
    if (hit2fa) {
      if (!phone) {
        throw new Error('被双重认证拦截且未提供手机号，无法短信验证——请补录手机号后重跑');
      }
      log(flow, '🔒 密码通过但被双重认证拦截，转入短信验证登录（等待人工填验证码）...');
      return await twofaSmsLogin(page, phone, flow);
    }
  }
  throw new Error('登录后未跳转（密码错误或被风控拦截）');
}

/**
 * 双重认证的短信验证登录（人工填码协助流程）：
 * 手机号登录 tab → 自动填手机号 → 自动点「获取验证码」（滑块人工）→
 * 挂起最长 5 分钟等人工在浏览器里填验证码 → 离开登录页即成功。
 * 注意：验证码到用户手机（实号），不走 LubanSMS。
 */
async function twofaSmsLogin(page: Page, phone: string, flow: FlowState): Promise<void> {
  const phoneTab = ['.el-tabs__item:has-text("手机号登录")', 'text=手机号登录'];
  try {
    await clickFirst(page, phoneTab, '「手机号登录」tab');
    await sleep(800);
  } catch {
    // 界面可能已在手机号 tab
  }
  const inp = await mustFindInput(page, SEL.phoneInput, '手机号输入框');
  await inp.fill('');
  await inp.fill(phone);
  // 勾协议（若在且未勾）
  const agree = page.locator('.el-checkbox').first();
  if ((await agree.count()) > 0) {
    const checked = await agree.evaluate((el) => el.classList.contains('is-checked')).catch(() => false);
    if (!checked) await agree.click({ timeout: 3000 }).catch(() => {});
  }
  step(flow, '2fa-send', `发送短信验证码到 ${phone}...`);
  await ensureNoCaptcha(page, flow);
  const sendBtn = await mustFindClickable(page, SEL.sendBtn, '「获取验证码」按钮');
  await sendBtn.click({ timeout: 10_000 });
  await waitForCaptchaOptional(page, flow);
  log(flow, `📲 验证码已发送到 ${phone}，等待人工在浏览器窗口填入（最长 5 分钟）...`);
  step(flow, '2fa-wait-code', `⏳ 请查收 ${phone} 的短信并填入验证码（填完自动继续）`);

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!page.url().includes('/login')) {
      log(flow, '✅ 短信验证登录成功');
      return;
    }
    await ensureNoCaptcha(page, flow);
  }
  throw new Error('等待人工填入短信验证码超时（5 分钟）');
}

export { log, step, sleep };

/** 打开中的会话注册表（accountId → 浏览器上下文 + 监控定时器） */
interface OpenSessionEntry {
  ctx: BrowserContext;
  monitor: NodeJS.Timeout;
  timer: NodeJS.Timeout;
  openedAt: string;
}
const openSessions = new Map<string, OpenSessionEntry>();

export function isSessionOpen(accountId: string): boolean {
  return openSessions.has(accountId);
}

/** 会话关闭前最后收割一次 token（防 15s 监控漏掉刚登录的），然后关浏览器 */
export async function closeSession(accountId: string): Promise<boolean> {
  const entry = openSessions.get(accountId);
  if (!entry) return false;
  clearInterval(entry.monitor);
  clearTimeout(entry.timer);
  try {
    const bmPage = entry.ctx.pages().find((p) => !p.isClosed() && p.url().includes('bigmodel.cn'));
    if (bmPage) {
      const tok = await readToken(bmPage);
      if (tok && !accountStore.tokenCandidates(accountId).includes(tok)) {
        accountStore.archiveToken(accountId, tok, 'manual-login');
        const acc = accountStore.get(accountId);
        if (acc) {
          acc.lastLoginAt = new Date().toISOString();
          acc.status = 'ok';
          acc.lastError = null;
        }
        accountStore.save();
        oplog('account.manual-login-captured', { username: acc?.username, at: 'close' });
      }
    }
  } catch {
    // 忽略
  }
  await entry.ctx.close().catch(() => {});
  openSessions.delete(accountId);
  oplog('account.session-closed', { accountId });
  return true;
}

/**
 * 打开一个该账号的浏览器会话（诊断/复原用）：
 * 优先用现有登录态；失效则塞备份 token 恢复。浏览器保持打开（10 分钟自动关闭，
 * 或点「关闭」立即关）。期间人工手动登录成功，15 秒内自动捕获新 token 入留痕。
 */
export async function openSession(
  accountId: string,
  token: string | null
): Promise<{ ok: boolean; msg: string }> {
  if (openSessions.has(accountId)) {
    return { ok: true, msg: '该账号已有一个打开的会话（点「关闭」可立即关闭）' };
  }
  const dir = path.join(config.profilesDir, accountId);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    channel: 'chrome',
    executablePath: config.chromePath,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=900,950'],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(config.bigmodel.settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(2500);
    if (!(await isLoggedIn(page)) && token) {
      await injectToken(page, token);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(2500);
    }
    const ok = await isLoggedIn(page);

    // 手动登录自动捕获：每 15 秒扫一次 bigmodel 页面的 token cookie
    const monitor = setInterval(async () => {
      try {
        const bmPage = ctx.pages().find((p) => !p.isClosed() && p.url().includes('bigmodel.cn'));
        if (!bmPage) return;
        const tok = await readToken(bmPage);
        if (!tok) return;
        if (accountStore.tokenCandidates(accountId).includes(tok)) return;
        accountStore.archiveToken(accountId, tok, 'manual-login');
        const acc = accountStore.get(accountId);
        if (acc) {
          acc.lastLoginAt = new Date().toISOString();
          acc.status = 'ok';
          acc.lastError = null;
        }
        accountStore.save();
        oplog('account.manual-login-captured', { username: acc?.username });
        console.log(`[OpenSession] 捕获手动登录 token 并留痕: ${acc?.username}`);
      } catch {
        // 页面可能正在导航/关闭，忽略
      }
    }, 15_000);

    const timer = setTimeout(() => {
      void closeSession(accountId);
    }, 10 * 60_000);
    timer.unref?.();

    openSessions.set(accountId, { ctx, monitor, timer, openedAt: new Date().toISOString() });
    // 用户手动关掉浏览器窗口时也要清理注册表
    ctx.on('close', () => {
      const entry = openSessions.get(accountId);
      if (entry) {
        clearInterval(entry.monitor);
        clearTimeout(entry.timer);
        openSessions.delete(accountId);
      }
    });
    oplog('account.session-opened', { accountId });

    return {
      ok,
      msg: ok
        ? '已打开登录好的浏览器（10 分钟自动关；期间手动登录的新 token 会自动留痕）'
        : '未能恢复登录态——浏览器已打开，手动登录后将自动捕获留痕',
    };
  } catch (err) {
    await ctx.close().catch(() => {});
    return { ok: false, msg: `打开会话失败: ${(err as Error).message}` };
  }
}
