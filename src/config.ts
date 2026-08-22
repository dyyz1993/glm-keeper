import path from 'path';
import fs from 'fs';

/** 项目根目录 */
export const projectRoot = process.cwd();

export const config = {
  port: Number(process.env.PORT) || 3020,
  host: process.env.HOST || '127.0.0.1',

  chromePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  dataDir: path.resolve(process.cwd(), 'data'),
  profilesDir: path.resolve(process.cwd(), 'data', 'profiles'),
  accountsFile: path.resolve(process.cwd(), 'data', 'accounts.json'),

  bigmodel: {
    settingsUrl: 'https://bigmodel.cn/usercenter/settings/account',
    loginUrl: 'https://bigmodel.cn/login',
    /** 登录态探测：带 Authorization 头，毫秒级不开浏览器 */
    probeUrl: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
    /** 唯一凭证 cookie（JWT，httpOnly=false，domain=.bigmodel.cn，7 天） */
    tokenCookie: 'bigmodel_token_production',
    tokenCookieDomain: '.bigmodel.cn',
  },

  keeper: {
    /** 保活周期：3 天重登一次（token 自然寿命 7 天，2 倍余量） */
    keepAliveDays: Number(process.env.KEEP_ALIVE_DAYS) || 3,
    /** token 自然寿命（天），用于看板倒计时 */
    tokenLifeDays: 7,
    /** 双人共用账号时自动同步（2FA/token 真实状态探测）间隔；0=关闭 */
    autoSweepMs: Number(process.env.AUTO_SWEEP_MS ?? 5 * 60_000),
    /** 等人工滑块超时 */
    captchaTimeoutMs: 180_000,
    /** 点击登录后等待跳转 */
    loginTimeoutMs: 30_000,
  },
};

export function ensureDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.profilesDir, { recursive: true });
}
