// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrollFlowPolicy } from '../src/client/scroll-flow-settings.ts'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => {
  function createSnapshotStore<T>(init: T): {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    set(next: T): void
    update(): void
  } {
    let state = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      set: (next: T) => { state = next; for (const l of listeners) l() },
      update: () => {},
    }
  }
  return { createSnapshotStore }
})

afterEach(() => {
  localStorage.clear()
})

describe('ScrollFlowPolicy localStorage 持久化', () => {
  it('切换后重建 policy 从 localStorage 恢复', () => {
    const first = new ScrollFlowPolicy()
    first.setFollowMode('gentle')
    first.setBounceEnabled(false)
    first.setTypewriterEnabled(false)

    const second = new ScrollFlowPolicy()
    expect(second.followMode.getSnapshot()).toBe('gentle')
    expect(second.bounceEnabled.getSnapshot()).toBe(false)
    expect(second.typewriterEnabled.getSnapshot()).toBe(false)
  })

  it('损坏的 localStorage 回退默认值', () => {
    localStorage.setItem('dsh-web-scroll-flow.settings', '{bad json')
    const policy = new ScrollFlowPolicy()
    expect(policy.followMode.getSnapshot()).toBe('medium')
    expect(policy.bounceEnabled.getSnapshot()).toBe(true)
    expect(policy.typewriterEnabled.getSnapshot()).toBe(true)
  })
})
