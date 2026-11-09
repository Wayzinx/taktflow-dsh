import { describe, expect, it } from 'vitest'
// @ts-ignore 根 tsconfig 用 NodeNext，不允许 .ts 后缀；vitest 需要显式 .ts 才能跨包解析。
import { hasErrors, toPatch, validateForm, type EnvForm, type Form } from '../../vendor/taktflow/packages/web/src/pages/settings/policy-form.ts'

function env(overrides: Partial<EnvForm> = {}): EnvForm {
  return {
    enabled: false,
    setup: '',
    deploy: '',
    healthKind: 'none',
    health: '',
    healthTimeoutSec: '',
    teardown: '',
    env: [],
    testCommand: '',
    ...overrides,
  }
}

function form(overrides: Partial<Form> = {}): Form {
  return {
    defaultWorkflow: 'quick-fix',
    autonomy: 'full',
    env: env(),
    selftestTimeoutMin: '',
    allowedCommands: [],
    budgetTokens: '',
    budgetMinutes: '',
    budgetCost: '',
    ...overrides,
  }
}

describe('运行策略校验', () => {
  it('保留合法小数预算，并原样保留带空格/逗号的命令', () => {
    const f = form({
      budgetCost: '0.25',
      budgetMinutes: '1.5',
      selftestTimeoutMin: '0.5',
      allowedCommands: ['npm run test:unit', 'node --test a,b.test.js'],
    })
    const check = validateForm(f)
    expect(check.errors).toEqual({})
    const patch = toPatch(f, form(), check.values)
    expect(patch.budget).toEqual({ costUsd: 0.25, minutes: 1.5 })
    expect(patch.selftest).toEqual({ timeoutMs: 30_000, allowedCommands: ['npm run test:unit', 'node --test a,b.test.js'] })
  })

  it('拒绝 1..5 这类非法数字，不再静默丢弃限制', () => {
    const check = validateForm(form({ selftestTimeoutMin: '1..5' }))
    expect(check.errors.selftestTimeout).toContain('正数')
    expect(check.values.selftestTimeoutMs).toBeUndefined()
    expect(hasErrors(check)).toBe(true)
  })

  it('拒绝 0 和负数，而不是把 -1 改成 1', () => {
    expect(validateForm(form({ budgetTokens: '0' })).errors.budgetTokens).toContain('大于 0')
    expect(validateForm(form({ budgetTokens: '-1' })).errors.budgetTokens).toContain('正数')
  })

  it('开启部署后，探活 URL 必填且必须是 http(s)', () => {
    const missing = validateForm(form({ env: env({ enabled: true, deploy: 'npm start', healthKind: 'url', health: '' }) }))
    expect(missing.errors.health).toContain('请填写探活 URL')
    const wrong = validateForm(form({ env: env({ enabled: true, deploy: 'npm start', healthKind: 'url', health: 'localhost:3000/health' }) }))
    expect(wrong.errors.health).toContain('http')
    const ok = validateForm(form({ env: env({ enabled: true, deploy: 'npm start', healthKind: 'url', health: 'http://localhost:3000/health', healthTimeoutSec: '1' }) }))
    expect(ok.errors).toEqual({})
    expect(ok.values.healthTimeoutMs).toBe(1000)
  })

  it('重复和非法环境变量名会阻止保存', () => {
    const dup = validateForm(form({ env: env({ enabled: true, deploy: 'npm start', env: [['A', '1'], ['A', '2']] }) }))
    expect(dup.errors.env?.join('；')).toContain('重复')
    expect(dup.invalidEnvRows.has(1)).toBe(true)
    const bad = validateForm(form({ env: env({ enabled: true, deploy: 'npm start', env: [['1A', 'x']] }) }))
    expect(bad.errors.env?.join('；')).toContain('不合法')
  })

  it('允许合法的空字符串和空白环境变量值，并原样提交', () => {
    const f = form({ env: env({ enabled: true, deploy: 'npm start', env: [['FOO', ''], ['BAR', '   ']] }) })
    const check = validateForm(f)
    expect(check.errors).toEqual({})
    expect(check.invalidEnvRows.size).toBe(0)
    const patch = toPatch(f, form(), check.values)
    expect(patch.environment?.env).toEqual({ FOO: '', BAR: '   ' })
  })

  it('清空预算/自测时显式提交 null，避免旧限制残留', () => {
    const original = form({ budgetTokens: '1000', selftestTimeoutMin: '5', allowedCommands: ['npm test'] })
    const f = form()
    const check = validateForm(f)
    expect(check.errors).toEqual({})
    const patch = toPatch(f, original, check.values)
    expect(patch.budget).toBeNull()
    expect(patch.selftest).toBeNull()
  })
})
