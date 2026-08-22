import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { accountStore } from './account-store.js';
import { oplog } from './oplog.js';

/**
 * 登录态采集（留痕）：headless 打开浏览器 profile 读取 token cookie。
 * 不导航、不登录、无滑块——profile 里的 cookie 磁盘加载即可读。
 *
 * 两个来源：
 * 1. keeper 自己的 profiles（data/profiles/<accountId>）
 * 2. browser-manager 的实例 profiles（按 nickname 映射到 keeper 账号）
 *    ——收割那 18+ 个账号已存在的登录态，免登录直接获得 token 备份
 *
 * 注意：profile 正被其他浏览器进程使用时会锁定，跳过并记录。
 */
async function readProfileToken(profileDir: string): Promise<{ token: string | null; err?: string }> {
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: 'chrome',
      executablePath: config.chromePath,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const cookies = await ctx.cookies(['https://bigmodel.cn']);
    const hit = cookies.find((c) => c.name === config.bigmodel.tokenCookie);
    return { token: hit?.value ?? null };
  } catch (err) {
    return { token: null, err: (err as Error).message };
  } finally {
    await ctx?.close().catch(() => {});
  }
}

export interface HarvestResult {
  scanned: number;
  archived: number;
  empty: number;
  locked: number;
  details: string[];
}

export async function harvestAll(): Promise<HarvestResult> {
  const result: HarvestResult = { scanned: 0, archived: 0, empty: 0, locked: 0, details: [] };
  const done = new Set<string>(); // 账号去重（两个来源都命中的只算一次）

  // 来源 1：keeper 自己的 profiles
  for (const acc of accountStore.list()) {
    const dir = path.join(config.profilesDir, acc.id);
    if (!fs.existsSync(dir)) continue;
    result.scanned++;
    const r = await readProfileToken(dir);
    await applyToken(acc.username, acc.id, r, result, done, 'harvest-keeper');
  }

  // 来源 2：browser-manager 实例（按 nickname 映射）
  const bmFile = path.resolve(process.cwd(), '..', 'browser-manager', 'server', 'data', 'instances.json');
  try {
    if (fs.existsSync(bmFile)) {
      const instances = JSON.parse(fs.readFileSync(bmFile, 'utf-8')) as Array<{
        nickname?: string | null;
        userDataDir: string;
      }>;
      for (const inst of instances) {
        if (!inst.nickname) continue;
        const acc = accountStore.findByUsername(inst.nickname);
        if (!acc || done.has(acc.id) || !fs.existsSync(inst.userDataDir)) continue;
        result.scanned++;
        const r = await readProfileToken(inst.userDataDir);
        await applyToken(inst.nickname, acc.id, r, result, done, 'harvest-browser-manager');
      }
    }
  } catch (err) {
    result.details.push(`browser-manager 数据读取失败: ${(err as Error).message}`);
  }

  oplog('tokens.harvest', { scanned: result.scanned, archived: result.archived });
  return result;
}

async function applyToken(
  username: string,
  accountId: string,
  r: { token: string | null; err?: string },
  result: HarvestResult,
  done: Set<string>,
  source: string
): Promise<void> {
  if (r.token) {
    const added = accountStore.archiveToken(accountId, r.token, source);
    if (added) {
      result.archived++;
      result.details.push(`✅ ${username}: token 已采集留痕（${source}）`);
    } else {
      result.details.push(`= ${username}: token 未变化，跳过`);
    }
    done.add(accountId);
  } else if (r.err) {
    result.locked++;
    result.details.push(`🔒 ${username}: profile 无法打开（可能正在使用中）`);
  } else {
    result.empty++;
    result.details.push(`· ${username}: profile 无 token（未登录过）`);
  }
}
