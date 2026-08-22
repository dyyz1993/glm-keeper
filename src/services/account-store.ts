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

  list(): Account[] {
    return [...this.accounts.values()].sort((a, b) =>
      (a.lastLoginAt ?? '').localeCompare(b.lastLoginAt ?? '')
    );
  }

  update(id: string, patch: Partial<Account>): Account | null {
    const a = this.accounts.get(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.save();
    return a;
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
