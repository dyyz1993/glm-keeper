import path from 'path';
import fs from 'fs';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { routes } from './routes.js';

// 兜底：防止未捕获的 Promise rejection 导致进程崩溃
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 未捕获的 Promise rejection:', reason);
});

async function main() {
  const app = Fastify({ logger: false });

  // 空 JSON body 兼容
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const text = body as string;
      done(null, text ? JSON.parse(text) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(routes);

  // 前端静态托管（vite build → web-dist）
  const webDist = path.resolve(process.cwd(), 'web-dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }

  // 双人共用账号：后台定期同步真实 2FA/token 状态（有变化才记日志，避免刷屏）
  if (config.keeper.autoSweepMs > 0) {
    const { sweepAll } = await import('./services/health-service.js');
    const { oplog } = await import('./services/oplog.js');
    setInterval(async () => {
      try {
        const r = await sweepAll();
        if (r.twofaFlips.length > 0 || r.dead > 0) {
          oplog('auto-sweep.changes', { dead: r.dead, flips: r.twofaFlips });
          for (const f of r.twofaFlips) {
            console.log(`[AutoSweep] ${f.username} 2FA: ${f.from ? '开' : '关'} → ${f.to ? '开' : '关'}（另一边操作过，已同步）`);
          }
        }
      } catch {
        // 忽略
      }
    }, config.keeper.autoSweepMs);
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`\n🔑 glm-keeper 已启动: http://localhost:${config.port}`);
  console.log(`   保活周期: ${config.keeper.keepAliveDays} 天 | token 寿命: ${config.keeper.tokenLifeDays} 天\n`);
}

main();
