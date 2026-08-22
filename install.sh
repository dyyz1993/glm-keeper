#!/usr/bin/env bash
# glm-keeper 一键安装器
# 用法：curl -fsSL https://raw.githubusercontent.com/dyyz1993/glm-keeper/main/install.sh | bash
set -e

REPO="https://github.com/dyyz1993/glm-keeper.git"
DIR="glm-keeper"
PORT="${PORT:-3020}"

echo "🔑 glm-keeper 一键安装器（GLM 账号保活操作台）"

# 依赖检查
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js（需要 22+）。安装：https://nodejs.org/"
  exit 1
fi
echo "✓ Node $(node -v)"

# Chrome 检查（浏览器自动化依赖）
CHROME=""
case "$(uname -s)" in
  Darwin) [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
  Linux)  CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)" ;;
esac
if [ -z "$CHROME" ]; then
  echo "⚠️  未检测到 Chrome/Chromium——保活登录需要它。"
  echo "   安装后设置环境变量 CHROME_PATH 指向可执行文件再启动。"
else
  echo "✓ 浏览器: $CHROME"
fi

# 获取代码
if [ -d "$DIR" ]; then
  echo "→ 目录 $DIR 已存在，更新代码..."
  cd "$DIR"
  git pull --ff-only 2>/dev/null || echo "  (更新跳过，继续用本地代码)"
else
  echo "→ 克隆仓库..."
  git clone --depth 1 "$REPO" "$DIR"
  cd "$DIR"
fi

# 安装与构建
echo "→ 安装依赖（npm install）..."
npm install --no-audit --no-fund
echo "→ 构建（npm run build）..."
npm run build

# 启动
echo "→ 启动服务（端口 $PORT）..."
if command -v lsof >/dev/null 2>&1; then
  lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
fi
nohup node dist/index.js > /tmp/glm-keeper.log 2>&1 &
sleep 2

echo ""
echo "=============================================="
echo "✅ 安装完成！打开  http://localhost:$PORT"
echo ""
echo "下一步："
echo "  1. 右上「📥 导入账号」：每行  用户名,密码"
echo "     （也可以直接粘贴从另一台机器「📤 导出会话包」得到的 JSON，"
echo "       会连登录态一起导入，无需重新登录）"
echo "  2. 点「🚀 保活到期账号」批量登录（滑块需要人工拖一下）"
echo "  3. 每 3 天跑一轮，账号登录态永续"
echo ""
echo "常用操作：🩺健康检查 | 🔒2FA 开关 | 👁打开会话 | 📦诊断包"
echo "数据都在 data/ 目录（含密码与 token，注意保密与备份）"
echo "=============================================="
