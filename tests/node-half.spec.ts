// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'

describe('node half settings registration', () => {
  it('静态声明 settings 服务依赖', () => {
    expect(inject).toContain('settings')
  })

  it('apply 时直接注册 dsh-web-scroll-flow namespace', () => {
    const register = vi.fn()
    apply({ settings: { register } } as never)
    expect(register).toHaveBeenCalledTimes(1)
    const [namespace, schema] = register.mock.calls[0] as [string, unknown]
    expect(namespace).toBe('dsh-web-scroll-flow')
    expect(schema).toBeDefined()
  })
})
