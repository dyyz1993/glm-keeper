import { config } from '../config.js';
import { accountStore } from './account-store.js';

/**
 * 登录态健康检查 + 双重认证管理：全部走 HTTP（不开浏览器）。
 * 实测协议（2026-08）：
 *   探测：GET  getCustomerInfo + Authorization → code:200=有效（含 enableTwoFa/customerName/...）
 *   开关：POST updateCustomerInfo + Authorization + {"enableTwoFa":bool} → 修改成功
 */
export interface ProbeResult {
  ok: boolean;
  username?: string;
  phoneMasked?: string;
  accountId?: string;
  enableTwoFa?: boolean;
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
      data?: {
        customerName?: string;
        phoneNumber?: string;
        customerNumber?: string;
        enableTwoFa?: boolean;
      };
    };
    if (data.code === 200 && data.data) {
      return {
        ok: true,
        username: data.data.customerName,
        phoneMasked: data.data.phoneNumber,
        accountId: data.data.customerNumber,
        enableTwoFa: data.data.enableTwoFa,
        msg: '有效',
      };
    }
    return { ok: false, msg: data.msg || `code=${data.code}` };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

/** 纯 HTTP 切换双重认证（免浏览器免滑块，实测 200 即生效） */
export async function setTwoFa(token: string, enable: boolean): Promise<void> {
  const res = await fetch('https://bigmodel.cn/api/biz/customer/updateCustomerInfo', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enableTwoFa: enable }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { code: number; msg: string };
  if (data.code !== 200) {
    throw new Error(`双重认证${enable ? '开启' : '关闭'}失败: ${data.msg || `code=${data.code}`}`);
  }
}

/** 批量探测所有有 token 备份的账号，更新健康状态（含 2FA 状态） */
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
      if (r.username) {
        if (r.username !== acc.username) {
          acc.note = `⚠️ 探测返回用户名 ${r.username} 与账号 ${acc.username} 不一致`;
        }
      }
      if (r.phoneMasked) acc.phoneMasked = r.phoneMasked;
      if (r.accountId) acc.accountId = r.accountId;
      if (r.enableTwoFa !== undefined) acc.twofaEnabled = r.enableTwoFa;
    } else {
      dead++;
    }
  }
  accountStore.save();
  return { checked, alive, dead };
}
