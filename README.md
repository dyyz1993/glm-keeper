# 🔑 glm-keeper — GLM 账号保活操作台

批量管理 GLM（bigmodel.cn）账号的登录态：**自动登录续签 + 双重认证管理 + 登录态（token）留痕与恢复**。业务方唯一要做的事：在提示时拖一下滑块。

## 核心特性

| 能力 | 说明 |
|------|------|
| 🚀 批量保活 | 3 天一轮自动重登（token 自然寿命 7 天，2 倍安全余量），服务端队列，刷新页面不中断 |
| 🔒 双重认证管理 | 面板一键开关（单账号/批量），HTTP 秒级；闲置=开（防他人盗登）、重登瞬间=关 |
| 🍯 登录态留痕 | 每次登录/采集的 token 全部入历史（最近 10 份），最新失效自动回退尝试历史 |
| 🩺 健康检查 | 毫秒级 HTTP 探测全部账号 token 有效性 + 2FA 状态，不开浏览器 |
| 👁 打开会话 | 用备份 token 开一个登录好的浏览器（诊断/手动操作），开关联动 + 自动收割手动登录 |
| 📦 诊断包 | 一键导出全部账号状态 + token + 流程日志 + 操作日志（给维护者排查/复原用） |
| 📥 批量导入 | 每行 `用户名,密码[,分组][,备注]`，按用户名去重 |

## 工作原理（单账号保活流程）

```
① HTTP：探测最新 token（失效则试历史留痕）→ 有效且 2FA 开着 → HTTP 关闭 2FA
② 浏览器：打开账号设置页
   ├─ 已登录 → 删当前 token → 重新登录（续签新 7 天）
   ├─ 未登录有备份 → 塞回 token 恢复（免滑块）→ 同上
   └─ 首次 → 用户名+密码直接登录
   ⏳ 登录时滑块需要人工（页面顶部黄色横幅提示）
③ 新 token 留痕存档 → HTTP 开启 2FA（闲置保险）→ 刷新落盘 → 关浏览器
```

## 快速开始（本地部署）

```bash
# 环境：Node 22+（本项目在 Node 25 验证）、Chrome/Chromium
git clone <repo> && cd glm-keeper
npm install            # 注意：目录内有 pnpm-workspace.yaml 防止依赖装到上层，用 npm
npm run build          # tsc + vite build → dist/ + web-dist/
npm start              # http://localhost:3020（单端口，前后端一体）
```

开发模式：`npm run dev`（tsx watch，端口 3020）；前端单独热更：`npx vite --root web --port 5181`。

## 生产部署

### 直接运行

```bash
npm run build
nohup node dist/index.js > /tmp/glm-keeper.log 2>&1 &
```

### systemd（开机自启 + 崩溃自动拉起）

```ini
# /etc/systemd/system/glm-keeper.service
[Unit]
Description=glm-keeper
After=network.target

[Service]
WorkingDirectory=/path/to/glm-keeper
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now glm-keeper
```

### 数据备份（⚠️ 核心资产）

```
data/
├── accounts.json    # 账号+密码+token 留痕（最高机密，永不出库）
├── profiles/        # 每账号浏览器 profile（登录态）
└── oplog.jsonl      # 操作审计日志
```

- 定期备份整个 `data/` 目录即可完整迁移/复原
- `data/` 已在 `.gitignore`，任何情况下不要提交或外传
- 迁移到新机器：拷贝 `data/` + 重新 `npm install && npm run build && npm start`

## 日常操作手册（业务方）

1. **导入账号**：右上「📥 导入账号」→ 每行 `用户名,密码` → 导入
2. **日常保活**：看表格「下次保活」列（红色 ⚠️ 已到期）→ 点「🚀 保活到期账号」→ 出现黄色横幅时去浏览器窗口拖滑块 → 循环直到队列跑完
3. **随手检查**：「🩺 健康检查」刷新 token/2FA 状态
4. **应急**：某账号异常 → 点「打开」亲眼检查/手动登录（新登录态自动留痕）→ 完事点「🔴 关闭」
5. **求助**：点「📦 导出诊断包」把 JSON 文件发给维护者

## API 速查

| 操作 | 方法 | 路径 |
|------|------|------|
| 账号列表（含 sessionOpen） | GET | `/api/accounts` |
| 批量导入 | POST | `/api/accounts/import` |
| 删除账号（连 profile） | DELETE | `/api/accounts/:id?purge=true` |
| 批量保活（默认到期账号） | POST | `/api/batch/start` |
| 停止队列 | POST | `/api/batch/stop` |
| 队列状态 | GET | `/api/batch/status` |
| token 健康全量探测 | POST | `/api/health/sweep` |
| 登录态采集留痕 | POST | `/api/tokens/harvest` |
| 单账号 2FA 开关 | POST | `/api/accounts/:id/twofa` `{enable}` |
| 批量 2FA 开关 | POST | `/api/twofa/batch` `{enable}` |
| 打开/关闭会话 | POST | `/api/accounts/:id/open-session` / `close-session` |
| 诊断包导出 | GET | `/api/support/export` |

## 常见问题

- **开 2FA 报「设置密码后可打开双重认证」**：平台要求账号设置过登录密码才能开 2FA——重设一次密码后即可
- **登录报「被双重认证拦截」**：2FA 开着且无 token 备份——点「打开」→ 手机短信手动登录 → 手动关 2FA → 关闭会话（token 自动留痕）→ 回归自动循环
- **滑块一直失败**：风控触发，流程会自动刷新页面重拿新挑战（同号最多 2 次）
- **token 全部失效**：7 天窗口过了——跑一次保活重新登录即全恢复

## 相关项目

- **browser-manager**（同级目录）：账号注册/养号工具，产出账号（用户名+密码）供本项目导入；其 profile 里的登录态可通过「🍯 采集登录态」直接收割
