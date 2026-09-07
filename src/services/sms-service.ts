import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * LubanSMS 客户端（与 browser-manager 同源实现）。
 * key 读取：env LUBAN_APIKEY > browser-manager/agents.md。
 * 致命错误（余额/欠费类）抛 LubanFatalError。
 */
export class LubanFatalError extends Error {}

const FATAL_MSG_PATTERN = /余额|欠费|充值|套餐|到期|禁用|异常账号/;

function fatalOrThrow(resp: { code: number; msg?: string }, action: string): void {
  if (Number(resp.code) === 0) return;
  const msg = resp.msg || `code=${resp.code}`;
  if (FATAL_MSG_PATTERN.test(msg)) {
    throw new LubanFatalError(`LubanSMS ${action}失败（余额/账户问题）: ${msg}`);
  }
  throw new Error(`LubanSMS ${action}失败: ${msg}`);
}

function apikey(): string {
  if (process.env.LUBAN_APIKEY) return process.env.LUBAN_APIKEY;
  const p = path.resolve(process.cwd(), '..', 'browser-manager', 'agents.md');
  try {
    const m = fs.readFileSync(p, 'utf-8').match(/LUBAN_APIKEY\s*[:=]\s*([A-Za-z0-9]+)/);
    if (m) return m[1];
  } catch {
    // 忽略
  }
  throw new LubanFatalError('未配置 LUBAN_APIKEY');
}

async function call<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ apikey: apikey(), ...params });
  const res = await fetch(`${config.lubanBase}/${endpoint}?${qs.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`LubanSMS HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const smsService = {
  /** 重新占用指定号码（收该号短信的前提） */
  async reAcquire(phone: string): Promise<void> {
    const r = await call<{ code: number; msg?: string; phone?: string }>('getKeywordNumber', { phone });
    fatalOrThrow(r, '请求号码');
  },

  /** 查短信（keyword 过滤）。未收到返回 null。 */
  async getSms(phone: string, keyword: string): Promise<string | null> {
    const r = await call<{ code: number; msg: string }>('getKeywordSms', { phone, keyword });
    if (r.code === 0) return r.msg;
    if (r.msg && r.msg.includes('尚未收到短信')) return null;
    fatalOrThrow(r, '获取短信');
    return null;
  },

  /** 释放号码 */
  async release(phone: string): Promise<void> {
    const r = await call<{ code: number; msg?: string }>('delKeywordNumber', { phone });
    fatalOrThrow(r, '释放号码');
  },
};
