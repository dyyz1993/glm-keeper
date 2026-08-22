import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config, ensureDirs } from '../config.js';
import type { Account } from '../types.js';

/** 账号库：内存 Map + data/accounts.json 持久化（含密码/token，本地文件勿外传） */
class AccountStore {
  private accounts = new Map<string, Account>();

  constructor() {
    ensureDirs();
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(config.accountsFile)) return;
      const raw = JSON.parse(fs.readFileSync(config.accountsFile, 'utf-8')) as Account[];
      for (const a of raw) {
        if (a?.id && a?.username) {
          a.status = 'idle';
          a.flow = null;
          this.accounts.set(a.id, a);
        }
      }
      console.log(`[AccountStore] 从磁盘恢复了 ${this.accounts.size} 个账号`);
    } catch (err) {
      console.warn('[AccountStore] 加载失败:', (err as Error).message);
    }
  }

  save(): void {
    const list = [...this.accounts.values()].map((a) => ({ ...a, flow: null, status: 'idle' as const }));
    fs.writeFileSync(config.accountsFile, JSON.stringify(list, null, 2), 'utf-8');
  }

  /** 批量导入（按用户名去重，已存在则更新密码） */
  import(rows: { username: string; password: string; group?: string; note?: string }[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const row of rows) {
      const exist = this.findByUsername(row.username);
      if (exist) {
        exist.password = row.password;
        if (row.group) exist.group = row.group;
        updated++;
        continue;
      }
      const account: Account = {
        id: uuidv4(),
        username: row.username,
        password: row.password,
        group: row.group,
        note: row.note,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        token: null,
        tokenIssuedAt: null,
        tokenBackupAt: null,
        tokenOk: null,
        tokenCheckedAt: null,
        twofaEnabled: null,
        keepAliveDays: config.keeper.keepAliveDays,
        status: 'idle',
        lastError: null,
        flow: null,
      };
      this.accounts.set(account.id, account);
      added++;
    }
    this.save();
    return { added, updated };
  }

  get(id: string): Account | null {
    return this.accounts.get(id) ?? null;
  }

  findByUsername(username: string): Account | null {
    for (const a of this.accounts.values()) if (a.username === username) return a;
    return null;
  }

  /** 固定按导入顺序返回（Map 插入序 = accounts.json 文件序，重启不变，不随登录时间跳动） */
  list(): Account[] {
    return [...this.accounts.values()];
  }

  update(id: string, patch: Partial<Account>): Account | null {
    const a = this.accounts.get(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.save();
    return a;
  }

  /** 候选 token 列表（最新优先 + 去重历史），恢复/关2FA 按序尝试 */
  tokenCandidates(id: string): string[] {
    const a = this.accounts.get(id);
    if (!a) return [];
    const seen = new Set<string>();
    const list: string[] = [];
    if (a.token && !seen.has(a.token)) {
      seen.add(a.token);
      list.push(a.token);
    }
    for (const h of a.tokenHistory ?? []) {
      if (h.token && !seen.has(h.token)) {
        seen.add(h.token);
        list.push(h.token);
      }
    }
    return list;
  }

  /**
   * token 留痕：登录成功/采集到 token 时调用。
   * 去重后写入历史（最多 10 份），并更新最新备份指针。
   */
  archiveToken(id: string, token: string, source: string): boolean {
    const a = this.accounts.get(id);
    if (!a || !token) return false;
    const now = new Date().toISOString();
    const hist = a.tokenHistory ?? [];
    if (a.token === token && hist[0]?.token === token) return false; // 已留痕
    if (!hist.some((h) => h.token === token)) {
      hist.unshift({ token, issuedAt: now, source });
      a.tokenHistory = hist.slice(0, 10);
    }
    a.token = token;
    a.tokenBackupAt = now;
    if (source === 'login') a.tokenIssuedAt = now; // 登录签发的才知准确时间；采集的用备份时间近似
    this.save();
    return true;
  }

  remove(id: string, purge: boolean): boolean {
    const a = this.accounts.get(id);
    if (!a) return false;
    this.accounts.delete(id);
    this.save();
    if (purge) {
      try {
        fs.rmSync(path.join(config.profilesDir, id), { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
    return true;
  }
}

export const accountStore = new AccountStore();
