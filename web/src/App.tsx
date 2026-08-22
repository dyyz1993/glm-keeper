import { useState, useEffect, useCallback } from 'react';
import { api, type Account, type BatchStatus } from './api.js';

const DAY = 86400_000;

/** 批量 2FA（可限定 ids） */
async function twofaBatch(enable: boolean, ids?: string[]) {
  const res = await fetch('/api/twofa/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enable, ids }),
  });
  return res.json() as Promise<{ ok: number; fail: number; errors: string[] }>;
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 距下次保活的剩余天数（负数=已到期） */
function daysLeft(a: Account): number | null {
  if (!a.lastLoginAt) return null;
  return a.keepAliveDays - (Date.now() - new Date(a.lastLoginAt).getTime()) / DAY;
}

const statusLabels: Record<string, string> = {
  idle: '待命', queued: '排队中', working: '处理中', 'waiting-slider': '等滑块', ok: '✅ 完成', error: '❌ 失败',
};

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [msg, setMsg] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.accounts(), api.batchStatus()]);
      setAccounts(a.data);
      setBatch(b.data);
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 5000);
  };

  /** 导出会话包（迁移用：账号+密码+token 登录态，另一台机器导入即用） */
  const doExportSessions = async () => {
    try {
      const res = await fetch('/api/sessions/export');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `glm-keeper-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash('会话包已导出（含密码+token，仅限自己迁移使用，勿外传）');
    } catch (err) {
      flash(`导出失败: ${(err as Error).message}`);
    }
  };

  const doImport = async () => {
    try {
      const r = await api.importAccounts(importText);
      if ((r as { tokensImported?: number }).tokensImported !== undefined) {
        flash(`会话包导入：账号 +${r.added}/更新${r.updated}，登录态 token ${(r as { tokensImported: number }).tokensImported} 个`);
      } else {
        flash(`导入完成：新增 ${r.added}，更新 ${r.updated}${r.bad.length ? `，无效行 ${r.bad.length}` : ''}`);
      }
      setShowImport(false);
      setImportText('');
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  const doBatchStart = async (ids?: string[]) => {
    try {
      await api.batchStart(ids);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  const doSweep = async () => {
    try {
      const r = await api.healthSweep();
      flash(`健康检查：${r.data.checked} 个 token，存活 ${r.data.alive}，失效 ${r.data.dead}`);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  /** 导出诊断包（含 token/流程日志/操作日志，JSON 下载） */
  const doExportSupport = async () => {
    try {
      const res = await fetch('/api/support/export');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `glm-keeper-support-${new Date().toISOString().slice(0, 16).replace('T', '_')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash('诊断包已导出（含 token 秘密，勿外传）');
    } catch (err) {
      flash(`导出失败: ${(err as Error).message}`);
    }
  };

  const doOpenSession = async (id: string, username: string) => {
    try {
      flash(`正在为 ${username} 打开会话...`);
      const res = await fetch(`/api/accounts/${id}/open-session`, { method: 'POST' });
      const r = await res.json();
      flash(`${username}: ${r.msg || r.error}`);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  const doCloseSession = async (id: string, username: string) => {
    try {
      const res = await fetch(`/api/accounts/${id}/close-session`, { method: 'POST' });
      const r = await res.json();
      flash(`${username}: ${r.msg || r.error}`);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  /** 面板直接切换单账号 2FA（HTTP，秒级） */
  const doToggle2FA = async (a: Account) => {
    const target = a.twofaEnabled === true ? false : true; // 未知当作关，切成开
    try {
      const res = await fetch(`/api/accounts/${a.id}/twofa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: target }),
      });
      const r = await res.json();
      if (r.error) flash(`${a.username}: ${r.error}`);
      else flash(`${a.username}: 双重认证已${target ? '开启 🔒' : '关闭 🔓'}`);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  /** 批量切换全部账号 2FA（有选中时只作用于选中） */
  const doBatch2FA = async (enable: boolean) => {
    const ids = selected.size > 0 ? [...selected] : undefined;
    const scope = ids ? `选中 ${ids.length} 个` : '全部';
    try {
      flash(`正在${scope}${enable ? '开启' : '关闭'}双重认证...`);
      const r = await twofaBatch(enable, ids);
      flash(`2FA ${scope}${enable ? '开启' : '关闭'}：成功 ${r.ok}，失败 ${r.fail}${r.errors?.length ? `（如 ${r.errors[0]}）` : ''}`);
      refresh();
    } catch (err) {
      flash((err as Error).message);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = accounts.length > 0 && accounts.every((a) => selected.has(a.id));
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(accounts.map((a) => a.id)));
  };

  /** 登录态采集留痕：读所有 profile（含 browser-manager）的 token 存档 */
  const doHarvest = async () => {
    try {
      flash('🍯 采集中（headless 逐个读取 profile，约每号 2 秒）...');
      const res = await fetch('/api/tokens/harvest', { method: 'POST' });
      const r = await res.json();
      const d = r.data || r;
      flash(`采集完成：扫 ${d.scanned} 个 profile，新留痕 ${d.archived}，空 ${d.empty}，锁定 ${d.locked}`);
      refresh();
    } catch (err) {
      flash(`采集失败: ${(err as Error).message}`);
    }
  };

  const due = accounts.filter((a) => {
    const d = daysLeft(a);
    return d === null || d <= 0;
  });
  const selectedAccount = accounts.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部操作栏 */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white px-6 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <h1 className="text-lg font-bold text-gray-900">🔑 GLM Keeper <span className="text-xs font-normal text-gray-400">账号保活操作台</span></h1>
          <div className="flex gap-2">
            <button onClick={() => setShowImport(true)} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">📥 导入账号</button>
            <button
              onClick={() => doBatchStart()}
              disabled={!!batch?.running}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              title="顺序处理所有到期账号：登录续签+存token+开双重认证"
            >
              🚀 保活到期账号 ({due.length})
            </button>
            <button
              onClick={() => doBatchStart(accounts.map((a) => a.id))}
              disabled={!!batch?.running || accounts.length === 0}
              className="rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              全部重跑
            </button>
            {batch?.running && (
              <button onClick={() => api.batchStop().then(refresh)} className="rounded-md bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-700">⏹ 停止</button>
            )}
            <button onClick={doSweep} className="rounded-md border border-green-300 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50">🩺 健康检查</button>
            <button
              onClick={() => doBatch2FA(true)}
              className="rounded-md border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
              title={selected.size > 0 ? `开启选中 ${selected.size} 个账号的双重认证` : '批量开启全部账号的双重认证（闲置保险，HTTP 秒级）'}
            >🔒 {selected.size > 0 ? `选中开2FA(${selected.size})` : '全部开2FA'}</button>
            <button
              onClick={() => { if (confirm(`确定${selected.size > 0 ? `关闭选中 ${selected.size} 个` : '批量关闭全部'}双重认证？关闭期间账号仅靠密码保护`)) doBatch2FA(false); }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              title="批量关闭（仅在需要批量重登前使用）"
            >🔓 {selected.size > 0 ? `选中关2FA(${selected.size})` : '全部关2FA'}</button>
            <button onClick={doHarvest} className="rounded-md border border-orange-300 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50" title="读取所有 profile（含 browser-manager）里的 token 存档留痕，免登录无滑块">🍯 采集登录态</button>
            <button onClick={doExportSessions} className="rounded-md border border-purple-300 px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-50" title="导出账号+密码+登录态（token）为 JSON——给另一台机器导入即用，含秘密勿外传">📤 导出会话包</button>
            <button onClick={doExportSupport} className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50" title="导出全部账号状态/token/流程日志/操作日志（含秘密，勿外传）">📦 导出诊断包</button>
          </div>
        </div>
        {msg && <div className="mx-auto mt-2 max-w-6xl text-xs text-blue-600">{msg}</div>}
      </header>

      <main className="mx-auto max-w-6xl p-6">
        {/* 滑块人工提示横幅 */}
        {batch?.waitingSlider && (
          <div className="mb-4 animate-pulse rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-center">
            <div className="text-lg font-bold text-amber-800">
              👉 请到弹出的浏览器窗口完成滑块验证（账号：{batch.currentUsername}）
            </div>
            <div className="mt-1 text-xs text-amber-600">拖完验证流程会自动继续，无需其他操作</div>
          </div>
        )}

        {/* 队列状态 */}
        {batch && (batch.running || batch.logs.length > 0) && (
          <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50/60 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-gray-800">
                批量保活 {batch.running ? '进行中' : '已结束'}
                {batch.total > 0 && <span className="ml-2 font-mono text-indigo-700">{Math.min(batch.done + (batch.running ? 1 : 0), batch.total)}/{batch.total}</span>}
                {batch.running && batch.currentUsername && (
                  <span className="ml-2 text-xs text-gray-600">当前：{batch.currentUsername}</span>
                )}
              </div>
            </div>
            {batch.logs.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded bg-gray-900 p-2 font-mono text-[11px] leading-relaxed text-gray-200">
                {batch.logs.slice(-12).map((l, i) => (
                  <div key={i}><span className="text-gray-500">{new Date(l.time).toLocaleTimeString('zh-CN')}</span> {l.msg}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 选中操作栏 */}
        {selected.size > 0 && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2">
            <span className="text-sm font-medium text-indigo-800">已选 {selected.size} 个账号</span>
            <button onClick={() => setSelected(new Set())} className="text-xs text-indigo-600 hover:underline">清空选择</button>
            <div className="flex-1" />
            <button
              onClick={() => { doBatchStart([...selected]); }}
              disabled={!!batch?.running}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >🚀 保活选中</button>
            <button
              onClick={() => doBatch2FA(true)}
              className="rounded-md border border-blue-400 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
            >🔒 选中开2FA</button>
            <button
              onClick={() => { if (confirm(`关闭选中 ${selected.size} 个的双重认证？`)) doBatch2FA(false); }}
              className="rounded-md border border-gray-400 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >🔓 选中关2FA</button>
            <button
              onClick={() => {
                if (!confirm(`删除选中的 ${selected.size} 个账号（连同登录数据）？此操作不可恢复！`)) return;
                Promise.all([...selected].map((id) => api.removeAccount(id))).then(() => {
                  setSelected(new Set());
                  refresh();
                });
              }}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
            >🗑 删除选中</button>
          </div>
        )}

        {/* 账号表 */}
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-xs text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="全选/清空" />
                </th>
                <th className="px-4 py-2 text-left">用户名</th>
                <th className="px-3 py-2 text-left">分组</th>
                <th className="px-3 py-2">双重认证</th>
                <th className="px-3 py-2">最近登录</th>
                <th className="px-3 py-2">下次保活</th>
                <th className="px-3 py-2">token</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">还没有账号——点右上「📥 导入账号」批量导入（每行：用户名,密码）</td></tr>
              )}
              {accounts.map((a) => {
                const d = daysLeft(a);
                const dueNow = d === null || d <= 0;
                const flow = a.flow;
                return (
              <tr
                key={a.id}
                className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${selectedId === a.id ? 'bg-blue-50' : ''}`}
                onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
              >
                <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                </td>
                <td className="px-4 py-2 font-medium text-gray-900">
                      {a.username}
                      {a.phoneMasked && <span className="ml-2 font-mono text-[11px] text-gray-400">{a.phoneMasked}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{a.group || '—'}</td>
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => doToggle2FA(a)}
                        disabled={!!batch?.running}
                        title={a.twofaEnabled === true ? '点击关闭双重认证（HTTP 秒级）' : '点击开启双重认证（HTTP 秒级）'}
                        className={`rounded px-2 py-0.5 text-[11px] font-medium disabled:opacity-40 ${
                          a.twofaEnabled === true
                            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                            : a.twofaEnabled === false
                              ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                              : 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                        }`}
                      >
                        {a.twofaEnabled === true ? '🔒 开' : a.twofaEnabled === false ? '🔓 关' : '❓ 点同步'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500">{fmt(a.lastLoginAt)}</td>
                    <td className={`px-3 py-2 text-center text-xs font-medium ${dueNow ? 'text-red-600' : 'text-gray-600'}`}>
                      {d === null ? '从未登录' : d <= 0 ? '⚠️ 已到期' : `剩 ${d.toFixed(1)} 天`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {a.tokenOk === true ? '✅' : a.tokenOk === false ? '❌' : a.token ? '❓' : '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {flow?.running ? (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-blue-700">{flow.stepText.slice(0, 14)}</span>
                      ) : (
                        <span className={a.status === 'error' ? 'text-red-600' : 'text-gray-500'}>{statusLabels[a.status] ?? a.status}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      {a.sessionOpen ? (
                        <button
                          onClick={() => doCloseSession(a.id, a.username)}
                          className="mr-1 rounded border border-red-400 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-100"
                          title="立即关闭该账号的会话浏览器（关闭前自动收割最新 token）"
                        >🔴 关闭</button>
                      ) : (
                        <button
                          onClick={() => doOpenSession(a.id, a.username)}
                          className="mr-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100"
                          title="打开一个登录好的浏览器（塞备份 token，10 分钟自动关）"
                        >打开</button>
                      )}
                      <button
                        onClick={() => doBatchStart([a.id])}
                        disabled={!!batch?.running}
                        className="mr-1 rounded border border-indigo-300 px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
                      >单跑</button>
                      <button
                        onClick={() => { if (confirm(`删除账号 ${a.username}（连同登录数据）？`)) api.removeAccount(a.id).then(refresh); }}
                        className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-500 hover:bg-red-50"
                      >删</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* 选中账号详情 */}
        {selectedAccount && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">{selectedAccount.username} 详情</h3>
              <div className="text-xs text-gray-400">
                token 存档: {selectedAccount.tokenBackupAt ? fmt(selected.tokenBackupAt) : '无'} ·
                2FA: {selectedAccount.twofaEnabled === true ? '开' : selected.twofaEnabled === false ? '关' : '未知'}
                {selectedAccount.lastError && <span className="ml-2 text-red-500">错误: {selected.lastError}</span>}
              </div>
            </div>
            {selectedAccount.flow?.logs?.length ? (
              <div className="max-h-48 overflow-y-auto rounded bg-gray-900 p-2 font-mono text-[11px] leading-relaxed text-gray-200">
                {selectedAccount.flow.logs.map((l, i) => (
                  <div key={i}><span className="text-gray-500">{new Date(l.time).toLocaleTimeString('zh-CN')}</span> {l.msg}</div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">还没有流程日志（点「单跑」开始第一次保活）</p>
            )}
          </div>
        )}
      </main>

      {/* 导入弹窗 */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h3 className="mb-2 text-base font-semibold text-gray-900">📥 批量导入账号</h3>
            <p className="mb-3 text-xs text-gray-500">两种格式：① 每行 <code className="rounded bg-gray-100 px-1">用户名,密码[,分组]</code>　② 直接粘贴「📤 导出会话包」的 JSON（连登录态一起导入）</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={10}
              autoFocus
              placeholder={'your_username,your_password\nuser2,your_password,分组名'}
              className="mb-4 w-full rounded-md border border-gray-300 p-2 font-mono text-sm focus:border-indigo-500 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowImport(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">取消</button>
              <button onClick={doImport} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
