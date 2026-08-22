import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountStore } from './services/account-store.js';
import { keeperService } from './services/keeper-service.js';
import { sweepAll } from './services/health-service.js';

const importSchema = z.object({
  /** 每行一个账号：用户名,密码[,分组]（支持 CSV 粘贴） */
  text: z.string().min(1),
});

export async function routes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ===== 账号 =====

  app.get('/api/accounts', async () => {
    return { data: accountStore.list() };
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
    return { added, updated, bad };
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
    return { success: true };
  });

  app.get('/api/batch/status', async () => {
    return { data: keeperService.getStatus() };
  });

  // ===== 登录态健康检查（HTTP 探测，不开浏览器） =====

  app.post('/api/health/sweep', async () => {
    const r = await sweepAll();
    return { data: r };
  });
}
