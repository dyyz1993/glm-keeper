import { config } from '../config.js';
import { accountStore } from './account-store.js';
import {
  withAccountBrowser,
  isLoggedIn,
  readToken,
  deleteToken,
  injectToken,
  read2FA,
  set2FA,
  passwordLogin,
  ensureNoCaptcha,
  log,
  step,
  sleep,
} from './session-service.js';
import type { Account, BatchStatus, FlowState } from '../types.js';

/**
 * 保活批量队列（服务端，页面刷新不影响）。
 *
 * 单账号保活流程（3 天一轮）：
 *   打开设置页
 *   ├─ 已登录：关双重认证（若开）→ 删 token cookie → 重新登录（续签）
 *   ├─ 未登录但有 token 备份：塞回备份 → 恢复成功则同上（免滑块恢复！）
 *   └─ 未登录无备份：直接用户名+密码登录（此时 2FA 必须是关的，否则需人工短信）
 *   登录成功 → 读 token 存档 → 开启双重认证 → 刷新落盘 → 关浏览器
 */
class KeeperService {
  private status: BatchStatus = {
    running: false,
    total: 0,
    done: 0,
    currentId: null,
    currentUsername: null,
    waitingSlider: false,
    logs: [],
  };
  private cancelFlag = false;

  getStatus(): BatchStatus {
    const cur = this.status.currentId ? accountStore.get(this.status.currentId) : null;
    this.status.waitingSlider = !!(cur?.flow?.step === 'slider');
    if (cur) this.status.currentUsername = cur.username;
    return this.status;
  }

  isRunning(): boolean {
    return this.status.running;
  }

  private log(msg: string): void {
    this.status.logs.push({ time: new Date().toISOString(), msg });
    if (this.status.logs.length > 150) this.status.logs.splice(0, this.status.logs.length - 150);
    console.log(`[Batch] ${msg}`);
  }

  /** 到期账号：从未登录 或 距上次登录超过 keepAliveDays */
  private dueAccounts(): Account[] {
    const now = Date.now();
    return accountStore
      .list()
      .filter((a) => {
        if (!a.lastLoginAt) return true;
        return now - new Date(a.lastLoginAt).getTime() > a.keepAliveDays * 86400_000;
      });
  }

  start(ids?: string[]): BatchStatus {
    if (this.status.running) throw new Error('批量任务正在进行中');
    const targets = ids?.length
      ? ids.map((id) => accountStore.get(id)).filter((a): a is Account => !!a)
      : this.dueAccounts();
    if (targets.length === 0) throw new Error('没有到期需要保活的账号');

    this.cancelFlag = false;
    this.status = { running: true, total: targets.length, done: 0, currentId: null, currentUsername: null, waitingSlider: false, logs: [] };
    for (const a of targets) a.status = 'queued';

    this.run(targets).catch((err) => this.log(`队列异常终止: ${(err as Error).message}`));
    return this.status;
  }

  stop(): boolean {
    if (!this.status.running) return false;
    this.cancelFlag = true;
    this.log('已请求取消：当前账号跑完为止');
    return true;
  }

  private checkCancel(): void {
    if (this.cancelFlag) throw new Error('已手动停止');
  }

  private async run(targets: Account[]): Promise<void> {
    try {
      for (let i = 0; i < targets.length; i++) {
        if (this.cancelFlag) {
          this.log('队列已取消');
          break;
        }
        const acc = accountStore.get(targets[i].id);
        if (!acc) continue;
        this.status.currentId = acc.id;
        this.status.done = i;
        this.log(`[${i + 1}/${targets.length}] ${acc.username} 开始保活...`);
        try {
          await this.keepAliveOne(acc);
          this.log(`[${i + 1}/${targets.length}] ✅ ${acc.username} 完成（登录续签 + 双重认证开启 + token 已存档）`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg === '已手动停止') throw err;
          acc.status = 'error';
          acc.lastError = msg;
          this.log(`[${i + 1}/${targets.length}] ❌ ${acc.username} 失败: ${msg}`);
        }
      }
      this.log('队列结束');
    } finally {
      this.status.running = false;
      this.status.currentId = null;
      this.status.waitingSlider = false;
    }
  }

  /** 单账号保活（浏览器全程在本函数内开关） */
  private async keepAliveOne(acc: Account): Promise<void> {
    const flow: FlowState = { running: true, step: 'init', stepText: '初始化', logs: [] };
    acc.flow = flow;
    acc.status = 'working';
    acc.lastError = null;

    await withAccountBrowser(acc.id, async (page) => {
      // 1. 打开账号设置页（已登录停留；未登录被重定向到 /login）
      step(flow, 'open', '打开账号设置页...');
      await page.goto(config.bigmodel.settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(3000);
      await ensureNoCaptcha(page, flow);
      this.checkCancel();

      let loggedIn = await isLoggedIn(page);

      // 2. 未登录 → 先尝试塞备份 token 恢复（零成本；7 天窗口内有效）
      if (!loggedIn && acc.token) {
        step(flow, 'restore', '尝试用备份 token 恢复登录态...');
        log(flow, `塞回备份 token（备份于 ${acc.tokenBackupAt?.slice(0, 16).replace('T', ' ')}）`);
        await injectToken(page, acc.token);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(2500);
        await ensureNoCaptcha(page, flow);
        loggedIn = await isLoggedIn(page);
        log(flow, loggedIn ? '✅ 备份 token 恢复登录态成功（免登录）' : '备份 token 已失效，走重新登录');
        this.checkCancel();
      }

      if (loggedIn) {
        // 3. 已登录（会话还在或恢复成功）：先关双重认证，为重新登录扫清障碍
        const twofa = await read2FA(page);
        acc.twofaEnabled = twofa;
        if (twofa === true) {
          log(flow, '检测到双重认证开启，先关闭（重登后再开）...');
          await set2FA(page, false, flow);
          acc.twofaEnabled = false;
        }
        // 4. 删掉当前 token → 进登录页 → 重新登录（续签新 token）
        step(flow, 'relogin', '删除当前会话，重新登录续签...');
        await deleteToken(page);
        await page.goto(config.bigmodel.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(2000);
        await ensureNoCaptcha(page, flow);
        this.checkCancel();
      }

      // 5. 用户名+密码登录（滑块可能需要人工）
      await passwordLogin(page, acc.username, acc.password, flow);
      this.checkCancel();

      // 6. 登录成功：进设置页 → 存档 token（登录态资产）
      step(flow, 'save-token', '存档新 token...');
      await page.goto(config.bigmodel.settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(2500);
      await ensureNoCaptcha(page, flow);
      const token = await readToken(page);
      if (!token) throw new Error('登录成功但未读到 token cookie');
      const now = new Date().toISOString();
      acc.token = token;
      acc.tokenIssuedAt = now;
      acc.tokenBackupAt = now;
      acc.tokenOk = true;
      acc.tokenCheckedAt = now;
      log(flow, `✅ 新 token 已存档（${token.slice(0, 24)}...，有效期 7 天）`);
      this.checkCancel();

      // 7. 开启双重认证（防他人用手机号+密码登录）
      const twofaAfter = await read2FA(page);
      acc.twofaEnabled = twofaAfter;
      if (twofaAfter !== true) {
        await set2FA(page, true, flow);
        acc.twofaEnabled = true;
      } else {
        log(flow, '双重认证已是开启状态');
      }

      // 8. 顺带采集账号信息（customerNumber）
      const accId = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.common-info'));
        for (const r of rows) {
          const label = (r.childNodes[0]?.textContent || '').trim();
          if (label.startsWith('账号ID')) return r.querySelector('.line-clamp-1')?.textContent?.trim() || null;
        }
        return null;
      });
      if (accId) acc.accountId = accId;

      // 9. 刷新落盘新会话，然后关浏览器（withAccountBrowser finally 负责）
      step(flow, 'flush', '刷新落盘登录态...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await sleep(2500);
    });

    acc.lastLoginAt = new Date().toISOString();
    acc.status = 'ok';
    acc.flow = { ...flow, running: false, step: 'done', stepText: '保活完成' };
  }
}

export const keeperService = new KeeperService();
