// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

describe('node half settings registration', () => {
  it('存在 settings 服务时注册 dsh-web-scroll-flow namespace', () => {
    const register = vi.fn()
    let callback: ((ctx: { settings: { register: typeof register } }) => void) | undefined
    const ctx = {
      inject(services: string[], fn: (ctx: unknown) => void): void {
        if (services.includes('settings')) callback = fn as typeof callback
      },
    }

    apply(ctx as never)
    expect(callback).toBeDefined()
    callback!({ settings: { register } })

    expect(register).toHaveBeenCalledTimes(1)
    const [namespace, schema] = register.mock.calls[0] as [string, unknown]
    expect(namespace).toBe('dsh-web-scroll-flow')
    expect(schema).toBeDefined()
  })
})
