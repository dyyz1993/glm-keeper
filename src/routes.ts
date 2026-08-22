import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountStore } from './services/account-store.js';
import { keeperService } from './services/keeper-service.js';
import { sweepAll } from './services/health-service.js';
import { oplog, readOplog } from './services/oplog.js';
import { openSession, closeSession, isSessionOpen } from './services/session-service.js';
import { harvestAll } from './services/harvest-service.js';
import { config } from './config.js';

const importSchema = z.object({
  /** 每行一个账号：用户名,密码[,分组]（支持 CSV 粘贴） */
  text: z.string().min(1),
});

export async function routes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ===== 账号 =====

  app.get('/api/accounts', async () => {
    const data = accountStore.list().map((a) => ({ ...a, sessionOpen: isSessionOpen(a.id) }));
    return { data };
  });

  app.post('/api/accounts/import', async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: '参数校验失败', details: parsed.error.format() };
    }
    const rows: { username: string; password: string; group?: string; note?: string }[] = [];
    const bad: string[] = [];
    for (const line of parsed.data.text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      // 标准格式：用户名,密码[,分组][,备注]
      const parts = t.split(/[,，\t]/).map((s) => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        rows.push({ username: parts[0], password: parts[1], group: parts[2] || undefined, note: parts[3] || undefined });
      } else {
        bad.push(t);
      }
    }
    if (rows.length === 0) {
      reply.code(400);
      return { error: '没有解析出有效账号（格式：用户名,密码）', bad };
    }
    const { added, updated } = accountStore.import(rows);
    oplog('accounts.import', { added, updated });
    return { added, updated, bad };
  });

  /** 打开该账号的登录会话（诊断/复原：塞备份 token，10 分钟自动关或手动关） */
  app.post<{ Params: { id: string } }>('/api/accounts/:id/open-session', async (request, reply) => {
    const acc = accountStore.get(request.params.id);
    if (!acc) {
      reply.code(404);
      return { error: '账号不存在' };
    }
    oplog('account.open-session', { username: acc.username });
    const r = await openSession(acc.id, acc.token);
    return r;
  });

  /** 立即关闭该账号的打开会话（关闭前最后收割一次 token） */
  app.post<{ Params: { id: string } }>('/api/accounts/:id/close-session', async (request, reply) => {
    const ok = await closeSession(request.params.id);
    if (!ok) {
      reply.code(400);
      return { error: '该账号没有打开的会话' };
    }
    return { success: true, msg: '会话已关闭（已做最后 token 收割）' };
  });

  /** 诊断包导出：全部账号状态 + token + 流程日志 + 操作日志（给 owner 复原/排查用） */
  app.get('/api/support/export', async () => {
    oplog('support.export');
    const accounts = accountStore.list().map((a) => ({
      username: a.username,
      group: a.group,
      note: a.note,
      accountId: a.accountId,
      phoneMasked: a.phoneMasked,
      twofaEnabled: a.twofaEnabled,
      lastLoginAt: a.lastLoginAt,
      tokenIssuedAt: a.tokenIssuedAt,
      tokenBackupAt: a.tokenBackupAt,
      tokenOk: a.tokenOk,
      tokenCheckedAt: a.tokenCheckedAt,
      status: a.status,
      lastError: a.lastError,
      /** 秘密：token 可直接塞回 cookie 复原登录态，诊断包勿外传 */
      token: a.token,
      flowLogs: a.flow?.logs ?? [],
    }));
    return {
      exportedAt: new Date().toISOString(),
      keepAliveDays: config.keeper.keepAliveDays,
      accounts,
      oplog: readOplog(500),
    };
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/api/accounts/:id',
    async (request, reply) => {
      const ok = accountStore.remove(request.params.id, request.query.purge === 'true');
      if (!ok) {
        reply.code(404);
        return { error: '账号不存在' };
      }
      return { success: true };
    }
  );

  // ===== 批量保活 =====

  app.post<{ Body: { ids?: string[] } }>('/api/batch/start', async (request, reply) => {
    try {
      const status = keeperService.start(request.body?.ids);
      return { data: status };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post('/api/batch/stop', async (request, reply) => {
    const ok = keeperService.stop();
    if (!ok) {
      reply.code(400);
      return { error: '没有进行中的批量任务' };
    }
    oplog('batch.stop');
    return { success: true };
  });

  app.get('/api/batch/status', async () => {
    return { data: keeperService.getStatus() };
  });

  // ===== 登录态健康检查（HTTP 探测，不开浏览器） =====

  app.post('/api/health/sweep', async () => {
    const r = await sweepAll();
    oplog('health.sweep', r);
    return { data: r };
  });

  // ===== 登录态采集留痕（headless 读 profile cookie，含 browser-manager 来源） =====

  app.post('/api/tokens/harvest', async () => {
    const r = await harvestAll();
    return { data: r };
  });
}
