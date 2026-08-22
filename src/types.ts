/** 账号当前状态 */
export type AccountStatus = 'idle' | 'queued' | 'working' | 'waiting-slider' | 'ok' | 'error';

export interface FlowLogEntry {
  time: string;
  msg: string;
}

/** 单账号保活流程状态（嵌入账号，随 accounts.json 之外的内存态） */
export interface FlowState {
  running: boolean;
  step: string;
  stepText: string;
  logs: FlowLogEntry[];
}

/** 登录态留痕：历史 token 备份（新旧会话并存，7 天内都能用，多留多保险） */
export interface TokenHistoryEntry {
  token: string;
  issuedAt: string;
  /** 来源：login=登录存档 / harvest=profile采集 */
  source: string;
}

export interface Account {
  id: string;
  username: string;            // bigmodel 用户名（登录用，不用手机号）
  password: string;            // 本地保存，界面脱敏展示
  accountId?: string;          // customerNumber
  phoneMasked?: string;        // 掩码手机号（探测接口返回）
  group?: string;
  note?: string;
  createdAt: string;

  lastLoginAt: string | null;  // 最近一次成功登录（续签）时间
  /** 登录态资产：备份的 token（可直接塞回 cookie 恢复登录态） */
  token: string | null;
  tokenIssuedAt: string | null;
  tokenBackupAt: string | null;
  /** 历史留痕（去重，最近 10 份；最新 token 失效时按序回退尝试） */
  tokenHistory?: TokenHistoryEntry[];
  /** 健康检查（HTTP 探测）结果 */
  tokenOk: boolean | null;
  tokenCheckedAt: string | null;

  twofaEnabled: boolean | null; // 双重认证状态（null=未知）
  keepAliveDays: number;        // 默认 3

  status: AccountStatus;
  lastError: string | null;
  flow: FlowState | null;       // 最近一次流程（含日志）
}

/** 批量队列状态 */
export interface BatchStatus {
  running: boolean;
  total: number;
  done: number;
  currentId: string | null;
  currentUsername: string | null;
  waitingSlider: boolean;
  logs: FlowLogEntry[];
}
