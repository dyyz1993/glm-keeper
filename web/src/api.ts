export interface Account {
  id: string;
  username: string;
  password: string;
  accountId?: string;
  phoneMasked?: string;
  group?: string;
  createdAt: string;
  lastLoginAt: string | null;
  token: string | null;
  tokenIssuedAt: string | null;
  tokenBackupAt: string | null;
  tokenOk: boolean | null;
  tokenCheckedAt: string | null;
  twofaEnabled: boolean | null;
  keepAliveDays: number;
  status: string;
  lastError: string | null;
  flow: { running: boolean; step: string; stepText: string; logs: { time: string; msg: string }[] } | null;
  /** 是否有打开的会话浏览器（运行时，不持久化） */
  sessionOpen?: boolean;
}

export interface BatchStatus {
  running: boolean;
  total: number;
  done: number;
  currentId: string | null;
  currentUsername: string | null;
  waitingSlider: boolean;
  logs: { time: string; msg: string }[];
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  accounts: () => request<{ data: Account[] }>('/api/accounts'),
  importAccounts: (text: string) =>
    request<{ added: number; updated: number; bad: string[] }>('/api/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  removeAccount: (id: string) => request<{ success: boolean }>(`/api/accounts/${id}?purge=true`, { method: 'DELETE' }),

  batchStart: (ids?: string[]) =>
    request<{ data: BatchStatus }>('/api/batch/start', { method: 'POST', body: JSON.stringify({ ids }) }),
  batchStop: () => request<{ success: boolean }>('/api/batch/stop', { method: 'POST' }),
  batchStatus: () => request<{ data: BatchStatus }>('/api/batch/status'),

  healthSweep: () =>
    request<{ data: { checked: number; alive: number; dead: number } }>('/api/health/sweep', { method: 'POST' }),
};
