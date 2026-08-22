import { config } from '../config.js';
import { accountStore } from './account-store.js';
import { probeToken, setTwoFa } from './health-service.js';
import { oplog } from './oplog.js';
import {
  withAccountBrowser,
  isLoggedIn,
  readToken,
  deleteToken,
  injectToken,
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
 * 双重认证全程走 HTTP（updateCustomerInfo，免浏览器免滑块，实测）：
 *   前置：旧 token 若有效且 2FA 开着 → HTTP 关闭（给重登扫清障碍）
 *   浏览器：只做登录（token 备份恢复 / 用户名+密码+人工滑块）→ 读新 token 存档
 *   后置：新 token HTTP 开启 2FA（闲置保险）
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
    oplog('batch.start', { total: targets.length, ids: targets.map((t) => t.username) });

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
        // 已知 2FA 开启且无 token 备份 → HTTP 关不掉，登录必被拦——直接跳过省滑块
        if (!acc.token && acc.twofaEnabled === true) {
          acc.status = 'error';
          acc.lastError = '2FA 开启且无 token 备份（无法自动关闭），需人工短信登录关闭 2FA 后重跑';
          accountStore.save();
          this.log(`[${i + 1}/${targets.length}] ⏭️ ${acc.username} 跳过：${acc.lastError}`);
          oplog('account.skip-2fa-locked', { username: acc.username });
          continue;
        }
        this.status.currentId = acc.id;
        this.status.done = i;
        this.log(`[${i + 1}/${targets.length}] ${acc.username} 开始保活...`);
        try {
          await this.keepAliveOne(acc);
          this.log(`[${i + 1}/${targets.length}] ✅ ${acc.username} 完成（登录续签 + 双重认证开启 + token 已存档）`);
          oplog('account.ok', { username: acc.username });
        } catch (err) {
          const msg = (err as Error).message;
          if (msg === '已手动停止') throw err;
          acc.status = 'error';
          acc.lastError = msg;
          accountStore.save();
          this.log(`[${i + 1}/${targets.length}] ❌ ${acc.username} 失败: ${msg}`);
          oplog('account.error', { username: acc.username, error: msg });
        }
      }
      this.log('队列结束');
    } finally {
      this.status.running = false;
      this.status.currentId = null;
      this.status.waitingSlider = false;
    }
  }

  /** 单账号保活：HTTP 管 2FA + 浏览器只做登录续签 */
  private async keepAliveOne(acc: Account): Promise<void> {
    const flow: FlowState = { running: true, step: 'init', stepText: '初始化', logs: [] };
    acc.flow = flow;
    acc.status = 'working';
    acc.lastError = null;

    // ── 前置（HTTP）：按序尝试候选 token（最新优先+历史留痕），有效则关 2FA ──
    const candidates = accountStore.tokenCandidates(acc.id);
    if (candidates.length > 0) {
      step(flow, 'twofa-off', '检查 token 并关闭双重认证（HTTP）...');
      let working: string | null = null;
      let probe = await probeToken(candidates[0]);
      if (!probe.ok && candidates.length > 1) {
        log(flow, '最新 token 已失效，尝试历史留痕...');
        for (const cand of candidates.slice(1)) {
          probe = await probeToken(cand);
          if (probe.ok) {
            working = cand;
            break;
          }
        }
      } else if (probe.ok) {
        working = candidates[0];
      }
      acc.tokenOk = !!working;
      acc.tokenCheckedAt = new Date().toISOString();
      if (working) {
        if (working !== acc.token) {
          acc.token = working;
          log(flow, '✅ 历史 token 命中（留痕兜底生效）');
        }
        acc.twofaEnabled = probe.enableTwoFa ?? acc.twofaEnabled;
        if (acc.twofaEnabled === true) {
          await setTwoFa(working, false);
          acc.twofaEnabled = false;
          log(flow, '✅ 双重认证已通过 HTTP 关闭（免浏览器）');
        } else {
          log(flow, '双重认证本就是关闭状态');
        }
      } else {
        log(flow, `⚠️ 所有备份 token 均失效，无法 HTTP 关 2FA——若 2FA 开着，登录会被拦截`);
      }
    }

    // ── 浏览器：登录续签（滑块可能需要人工） ──
    let newToken: string | null = null;
    await withAccountBrowser(acc.id, async (page) => {
      step(flow, 'open', '打开账号设置页...');
      await page.goto(config.bigmodel.settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(3000);
      await ensureNoCaptcha(page, flow);
      this.checkCancel();

      let loggedIn = await isLoggedIn(page);

      // 未登录 → 按序尝试候选 token 恢复（最新优先，历史留痕兜底，最多试 3 个）
      if (!loggedIn && candidates.length > 0) {
        for (const cand of candidates.slice(0, 3)) {
          const isLatest = cand === candidates[0];
          step(flow, 'restore', `尝试${isLatest ? '最新' : '历史'}备份 token 恢复登录态...`);
          await injectToken(page, cand);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          await sleep(2500);
          await ensureNoCaptcha(page, flow);
          if (await isLoggedIn(page)) {
            loggedIn = true;
            log(flow, `✅ 备份 token 恢复登录态成功（${isLatest ? '最新' : '历史留痕兜底'}）`);
            break;
          }
        }
        if (!loggedIn) log(flow, '备份 token 全部失效，走重新登录');
        this.checkCancel();
      }

      if (loggedIn) {
        // 已登录（会话还在或恢复成功）→ 删 token 强制重新登录（续签新 7 天）
        step(flow, 'relogin', '删除当前会话，重新登录续签...');
        await deleteToken(page);
        await page.goto(config.bigmodel.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(2000);
        await ensureNoCaptcha(page, flow);
        this.checkCancel();
      }

      // 用户名+密码登录（滑块人工）
      await passwordLogin(page, acc.username, acc.password, flow);
      this.checkCancel();

      // 登录成功 → 读新 token
      step(flow, 'save-token', '读取并存档新 token...');
      await page.goto(config.bigmodel.settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(2000);
      await ensureNoCaptcha(page, flow);
      newToken = await readToken(page);
      if (!newToken) throw new Error('登录成功但未读到 token cookie');
      this.checkCancel();
    });

    const now = new Date().toISOString();
    if (!newToken) throw new Error('未获取到新 token');
    accountStore.archiveToken(acc.id, newToken, 'login'); // 留痕（历史+最新指针）
    acc.tokenOk = true;
    acc.tokenCheckedAt = now;
    log(flow, `✅ 新 token 已留痕存档（有效期 7 天，历史备份 ${(acc.tokenHistory ?? []).length} 份）`);

    // ── 后置（HTTP）：新 token 开启 2FA（闲置保险） ──
    step(flow, 'twofa-on', '开启双重认证（HTTP）...');
    await setTwoFa(newToken, true);
    acc.twofaEnabled = true;
    log(flow, '✅ 双重认证已通过 HTTP 开启');

    acc.lastLoginAt = now;
    acc.status = 'ok';
    acc.flow = { ...flow, running: false, step: 'done', stepText: '保活完成' };
    accountStore.save(); // 关键：token 等资产立即落盘，防止重启丢失
  }
}

export const keeperService = new KeeperService();
