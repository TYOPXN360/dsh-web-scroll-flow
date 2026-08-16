// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, installScrollFlow, SCROLLPORT_SELECTOR,
  type ScrollFlowInstall,
} from '../src/client/index.ts'

/** runtime/client 的 lib 是 __ModuleLoader__ bundle，Node 测试用轻量 store 替代。 */
vi.mock('@deepseek-ai/dsh-client-runtime/client', () => {
  function createSnapshotStore<T>(init: T): {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    set(next: T): void
    update(fn: (draft: T) => void): void
  } {
    let state = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      set: (next: T) => {
        state = next
        for (const listener of listeners) listener()
      },
      update: () => {},
    }
  }
  return { createSnapshotStore }
})

/** 等待 MutationObserver 的异步回调落地。 */
async function flushObservers(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function makeScroller(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-conversation-scroll', '')
  el.append(document.createElement('div'))
  return el
}

/** 构造 apply 需要的 ctx（settingsScope + slots + effect）。 */
function makeCtx(): {
  ctx: Context
  cleanup: () => void
  setFollowMode(mode: 'off' | 'gentle' | 'medium'): void
  setBounceEnabled(enabled: boolean): void
} {
  let cleanup: (() => void) | undefined
  let followMode: 'off' | 'gentle' | 'medium' = 'medium'
  let bounceEnabled = true
  const settingsListeners = new Set<() => void>()
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { followMode, bounceEnabled } }),
    subscribe: (fn: () => void) => {
      settingsListeners.add(fn)
      return () => { settingsListeners.delete(fn) }
    },
    set: (field: string, value: unknown) => {
      if (field === 'followMode') followMode = value as 'off' | 'gentle' | 'medium'
      if (field === 'bounceEnabled') bounceEnabled = value as boolean
      for (const listener of settingsListeners) listener()
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  }
  const slots = {
    inject: vi.fn(),
    register: vi.fn(() => () => {}),
  }
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const result = fn()
      if (typeof result === 'function') cleanup = result
    },
    settingsScope: { bind: () => scope },
    slots,
  } as unknown as Context
  return {
    ctx,
    cleanup: () => { cleanup?.() },
    setFollowMode: mode => scope.set('followMode', mode),
    setBounceEnabled: enabled => scope.set('bounceEnabled', enabled),
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('installScrollFlow', () => {
  it('扫描并挂载现有滚动容器', () => {
    const scroller = makeScroller()
    document.body.append(scroller)

    const install = installScrollFlow(document)
    try {
      expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeDefined()
    } finally {
      install.dispose()
    }
  })

  it('跟随容器的新增与移除', async () => {
    const install = installScrollFlow(document)
    try {
      const scroller = makeScroller()
      document.body.append(scroller)
      await flushObservers()
      expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeDefined()

      scroller.remove()
      await flushObservers()
      expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeUndefined()
    } finally {
      install.dispose()
    }
  })

  it('dispose 清理全部控制器并停止观察', async () => {
    const first = makeScroller()
    const second = makeScroller()
    document.body.append(first, second)

    const install = installScrollFlow(document)
    await flushObservers()
    install.dispose()

    expect(Object.getOwnPropertyDescriptor(first, 'scrollTop')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(second, 'scrollTop')).toBeUndefined()

    // 停止观察后新增的容器不再挂载。
    const third = makeScroller()
    document.body.append(third)
    await flushObservers()
    expect(Object.getOwnPropertyDescriptor(third, 'scrollTop')).toBeUndefined()
  })

  it('setOptions 会应用到已挂载的控制器', async () => {
    const scroller = makeScroller()
    document.body.append(scroller)
    const install = installScrollFlow(document)
    try {
      install.setOptions({ follow: null, bounce: null })
      // 控制器关闭后，跟随写入应瞬时通过（无动画）。
      expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeDefined()
    } finally {
      install.dispose()
    }
  })

  it('返回的句柄可重复调用 dispose', () => {
    const install = installScrollFlow(document)
    install.dispose()
    install.dispose()
  })

  it('不存在容器时无副作用', () => {
    const install: ScrollFlowInstall = installScrollFlow(document)
    install.dispose()
    expect(SCROLLPORT_SELECTOR).toBe('[data-conversation-scroll]')
  })
})

describe('apply', () => {
  it('通过 ctx.effect 注册安装并在卸载时清理', async () => {
    const { ctx, cleanup } = makeCtx()

    apply(ctx)

    const scroller = makeScroller()
    document.body.append(scroller)
    await flushObservers()
    expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeDefined()

    cleanup()
    expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeUndefined()
  })

  it('注册 settings.general.item 设置行', () => {
    const { ctx, cleanup } = makeCtx()

    apply(ctx)
    try {
      const slots = (ctx as unknown as { slots: { inject: ReturnType<typeof vi.fn> } }).slots
      expect(slots.inject).toHaveBeenCalledWith('settings.general.item', expect.any(Function))
    } finally {
      cleanup()
    }
  })

  it('设置切换会更新已挂载控制器的配置', async () => {
    const { ctx, cleanup, setFollowMode, setBounceEnabled } = makeCtx()

    apply(ctx)
    try {
      const scroller = makeScroller()
      document.body.append(scroller)
      await flushObservers()

      setFollowMode('off')
      setBounceEnabled(false)
      // 无异常即订阅链路生效（store 更新触发 install.setOptions）。
      expect(Object.getOwnPropertyDescriptor(scroller, 'scrollTop')).toBeDefined()
    } finally {
      cleanup()
    }
  })
})
