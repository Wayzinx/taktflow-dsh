import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentCommandVariable, type NodeContext } from '@taktflow/core'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function ctxWithConfig(config: unknown): Promise<NodeContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-env-var-'))
  roots.push(root)
  await writeFile(path.join(root, 'takt.config.json'), JSON.stringify(config))
  return { projectDir: root } as unknown as NodeContext
}

describe('用例命令环境变量解析', () => {
  it('config.env 优先，并按与命令一致的规则解析 ${宿主变量}', async () => {
    process.env.TAKT_ENV_VAR_HOST = 'host-value'
    try {
      const ctx = await ctxWithConfig({ environment: { deploy: 'true', env: { TAKT_ENV_VAR_TEST: 'config-${TAKT_ENV_VAR_HOST}' } } })
      await expect(environmentCommandVariable(ctx, 'TAKT_ENV_VAR_TEST'))
        .resolves.toEqual({ value: 'config-host-value', source: 'environment.env' })
    } finally {
      delete process.env.TAKT_ENV_VAR_HOST
    }
  })

  it('config.env 缺少时回落到宿主进程环境并标注来源', async () => {
    process.env.TAKT_ENV_VAR_FALLBACK = 'inherited'
    try {
      const ctx = await ctxWithConfig({ environment: { deploy: 'true' } })
      await expect(environmentCommandVariable(ctx, 'TAKT_ENV_VAR_FALLBACK'))
        .resolves.toEqual({ value: 'inherited', source: 'host-process' })
    } finally {
      delete process.env.TAKT_ENV_VAR_FALLBACK
    }
  })

  it('两处都缺失时明确返回空，不猜测', async () => {
    const ctx = await ctxWithConfig({ environment: { deploy: 'true' } })
    await expect(environmentCommandVariable(ctx, 'TAKT_ENV_VAR_MISSING')).resolves.toEqual({})
  })

  it('config.env 引用未设置的宿主变量时给出错误而不是空值', async () => {
    const ctx = await ctxWithConfig({ environment: { deploy: 'true', env: { TAKT_ENV_VAR_BROKEN: '${TAKT_ENV_VAR_NOT_SET}' } } })
    const result = await environmentCommandVariable(ctx, 'TAKT_ENV_VAR_BROKEN')
    expect(result.value).toBeUndefined()
    expect(result.source).toBe('environment.env')
    expect(result.error).toContain('TAKT_ENV_VAR_NOT_SET')
  })
})
