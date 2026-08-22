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

  await app.listen({ port: config.port, host: config.host });
  console.log(`\n🔑 glm-keeper 已启动: http://localhost:${config.port}`);
  console.log(`   保活周期: ${config.keeper.keepAliveDays} 天 | token 寿命: ${config.keeper.tokenLifeDays} 天\n`);
}

main();
