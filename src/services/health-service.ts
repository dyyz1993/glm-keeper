import { config } from '../config.js';
import { accountStore } from './account-store.js';

/**
 * 登录态健康检查：拿备份的 token 直接发 HTTP 请求（不开浏览器、毫秒级）。
 * 实测协议：GET getCustomerInfo + Authorization 头 → code:200=有效 / 401=失效。
 */
export interface ProbeResult {
  ok: boolean;
  username?: string;
  phoneMasked?: string;
  msg: string;
}

export async function probeToken(token: string): Promise<ProbeResult> {
  try {
    const res = await fetch(config.bigmodel.probeUrl, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      code: number;
      msg: string;
      data?: { customerName?: string; phoneNumber?: string; customerNumber?: string };
    };
    if (data.code === 200 && data.data) {
      return {
        ok: true,
        username: data.data.customerName,
        phoneMasked: data.data.phoneNumber,
        msg: '有效',
      };
    }
    return { ok: false, msg: data.msg || `code=${data.code}` };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

/** 批量探测所有有 token 备份的账号，更新健康状态 */
export async function sweepAll(): Promise<{ checked: number; alive: number; dead: number }> {
  let alive = 0;
  let dead = 0;
  let checked = 0;
  for (const acc of accountStore.list()) {
    if (!acc.token) continue;
    checked++;
    const r = await probeToken(acc.token);
    acc.tokenOk = r.ok;
    acc.tokenCheckedAt = new Date().toISOString();
    if (r.ok) {
      alive++;
      if (r.username && r.username !== acc.username) {
        acc.note = `⚠️ 探测返回用户名 ${r.username} 与账号 ${acc.username} 不一致`;
      }
      if (r.phoneMasked) acc.phoneMasked = r.phoneMasked;
    } else {
      dead++;
    }
  }
  accountStore.save();
  return { checked, alive, dead };
}
