import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * 持久化操作日志（JSONL 追加写，data/oplog.jsonl）。
 * 给"别人用出问题时导出诊断"用：谁在什么时候做了什么、每个账号的流程结果。
 */
const file = path.join(config.dataDir, 'oplog.jsonl');

export function oplog(event: string, detail: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...detail });
    fs.appendFileSync(file, line + '\n');
  } catch {
    // 日志失败不阻断业务
  }
}

/** 读取最近 tail 行 */
export function readOplog(tail = 500): string[] {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    return lines.slice(-tail);
  } catch {
    return [];
  }
}
