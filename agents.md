# agents.md — glm-keeper 项目指引

> 本文件含项目关键机制说明。`data/accounts.json` 含账号密码和 token，已被 .gitignore 排除，**永不提交**。

## 项目定位

GLM 账号保活操作台（业务方专用）：批量「用户名+密码登录续签 → 存 token → 开双重认证」，3 天一轮；登录态丢失用备份 token 恢复。与 browser-manager（养号工具）分离，账号通过用户名+密码导入。

## 启动

```bash
cd glm-keeper
# 构建
npm run build          # tsc + vite build web → web-dist/
# 启动（端口 3020，单端口前后端一体）
nohup /Users/xuyingzhou/.nvm/versions/node/v25.2.1/bin/node dist/index.js > /tmp/glm-keeper.log 2>&1 &
# 开发模式前端（5181）
npx vite --root web --port 5181
```

注意：本目录有 pnpm-workspace.yaml（packages: [.]）防止依赖被装到上层 workspace；用 npm install。

## bigmodel 登录态机制（2026-08 实测，改动前必读）

- **唯一凭证**：Cookie `bigmodel_token_production`（JWT、httpOnly=false、domain=.bigmodel.cn、7 天）。LocalStorage 与登录态无关
- **删/写该 cookie 必须带 `domain=.bigmodel.cn` 属性**，否则不生效
- **塞回 token = 秒恢复登录态**（7 天窗口内，可跨浏览器/机器移植）；**但不能续命**，寿命从签发算 7 天
- **续命 = 重新登录**（签新 token）；每次登录轮换 user_key，新旧会话并存无互踢
- **健康探测**：`GET /api/biz/customer/getCustomerInfo` + header `Authorization: <token>` → code:200=有效（**响应含 enableTwoFa/customerName/customerNumber/掩码手机号**，一石三鸟）/ 401=失效（毫秒级、不开浏览器）
- **双重认证开关（纯 HTTP，实测）**：`POST /api/biz/customer/updateCustomerInfo` + `Authorization` + body `{"enableTwoFa":bool}` → 200 修改成功。免浏览器免滑块；keeper 全程用此接口管 2FA
- **改密会踢会话**；活跃使用时前端会滑动刷新 cookie 的 7 天窗口

## 保活流程（keeper-service，单账号）

```
打开设置页
├─ 已登录：关双重认证（若开）→ 删 token cookie → 重新登录（续签）
├─ 未登录但有备份 token：塞回 → 恢复成功则走上面（免滑块）
└─ 未登录无备份：直接登录（此场景 2FA 必须是关的，否则需人工短信）
登录成功 → 存档 token → 开启双重认证 → 刷新落盘 → 关浏览器
```

**双重认证语义**：闲置=开（防他人用手机号+密码登录）；重登前=关。滑块需人工（界面有黄色横幅提示）。

## 架构

```
src/
├── config.ts               端口 3020、路径、bigmodel 常量、保活参数
├── types.ts                Account / BatchStatus / FlowState
├── routes.ts               账号 CRUD/导入、批量 start/stop/status、健康探测
└── services/
    ├── account-store.ts    accounts.json 持久化（含密码/token）
    ├── session-service.ts  浏览器自动化：登录/token 读写/2FA 开关/滑块等待
    ├── health-service.ts   token HTTP 探测 + 批量 sweep
    └── keeper-service.ts   顺序批量队列（服务端，页面刷新不影响）
web/                        React 19 + Vite + Tailwind 操作台（导入/批量/横幅/账号表）
data/                       运行时（gitignore）：accounts.json + profiles/<id>/
```

## API 速查

| 操作 | 方法 | 路径 |
|------|------|------|
| 账号列表 | GET | `/api/accounts` |
| 批量导入（每行 用户名,密码[,分组]） | POST | `/api/accounts/import` |
| 删除（连 profile） | DELETE | `/api/accounts/:id?purge=true` |
| 批量保活（默认只跑到期账号；可传 ids） | POST | `/api/batch/start` |
| 停止 | POST | `/api/batch/stop` |
| 队列状态（waitingSlider=需要人工滑块） | GET | `/api/batch/status` |
| token 健康探测（全量） | POST | `/api/health/sweep` |

## 已知约定

- 登录一律用**用户名**（不用手机号）——账号登录 tab `input[placeholder="请输入用户名/邮箱/手机号"]`
- 滑块检测：`.tencent-captcha-dy__content` 与视口有交集才算真弹出（常驻容器离屏，isVisible 会误判——历史教训）
- 2FA 开关：设置页 `.common-info:has-text("双重认证")` 行内的 `[role="switch"].el-switch`，点击后可能有确认弹窗+滑块
- 批量队列串行（一次一个滑块等人），账号间隔由人滑滑块的节奏天然拉开
