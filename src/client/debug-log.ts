/**
 * 轻量调试日志：环形缓冲 + 全局读取接口。
 *
 * 默认始终记录到内存缓冲（每次记录只是 push 一个对象，开销可忽略），
 * 方便排查"快速思考时页面被推上去 / 打字机先显示再消失"这类时间线问题；
 * 只有设置 `dsh-web-scroll-flow.debug = '1'`（localStorage）或 URL 带
 * `dsh-debug` 时才额外输出到 console，避免刷屏。
 *
 * 读取：`window.__dshScrollFlowDebug.dump()` 返回全部条目，
 * `window.__dshScrollFlowDebug.clear()` 清空。
 */

export interface DebugEntry {
  /** performance.now() 时间戳（ms）。 */
  t: number
  /** Date.now() 时间戳。 */
  ts: number
  /** 分类标签（scroll / typewriter / install…）。 */
  tag: string
  /** 人类可读描述。 */
  msg: string
  [key: string]: unknown
}

const MAX_ENTRIES = 5000
const entries: DebugEntry[] = []

let consoleEnabled = false
try {
  consoleEnabled = typeof localStorage !== 'undefined'
    && (localStorage.getItem('dsh-web-scroll-flow.debug') === '1'
      || (typeof location !== 'undefined' && location.search.includes('dsh-debug')))
} catch {
  consoleEnabled = false
}

/** 记录一条调试日志（始终入缓冲；console 输出受开关控制）。 */
export function debugLog(tag: string, msg: string, data?: Record<string, unknown>): void {
  const entry: DebugEntry = { t: performance.now(), ts: Date.now(), tag, msg, ...(data ?? {}) }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (consoleEnabled) {
    // eslint-disable-next-line no-console
    console.debug(`[dsh-scroll-flow:${tag}] ${msg}`, data ?? '')
  }
}

/** 取出全部缓冲条目（拷贝，避免调用方修改内部缓冲）。 */
export function debugDump(): DebugEntry[] {
  return entries.slice()
}

/** 清空缓冲（排查新一轮问题时先清空，再等事件发生）。 */
export function debugClear(): void {
  entries.length = 0
}

/** 在 window 上挂载全局读取接口（index.ts 调用一次）。 */
export function mountDebugGlobal(): void {
  if (typeof window === 'undefined') return
  const g = window as unknown as {
    __dshScrollFlowDebug?: { dump(): DebugEntry[]; clear(): void; enabled: boolean }
  }
  if (g.__dshScrollFlowDebug !== undefined) return
  g.__dshScrollFlowDebug = {
    dump: debugDump,
    clear: debugClear,
    enabled: consoleEnabled,
  }
}
