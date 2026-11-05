import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, type WorkflowDefinition } from '@taktflow/core'
import { FsSpaceRegistry } from './space.js'
import { knowledgeForRun, loadRunProfiles, loadRunRuntime } from './run-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-runtime-'))
  roots.push(root)
  const stores = await initProject(root)
  const space = await new FsSpaceRegistry().open(root)
  return { root, stores, space }
}

it('角色解析保留allowBash与skills，错误的allowBash不能静默忽略', async () => {
  const { space, stores } = await fixture()
  const file = join(stores.taktDir, 'agents/dev.md')
  const markdown = '---\nrole: dev\nharness: dsh-host\nallowBash: true\nskills: [review]\nwriteScope: ["src/**"]\n---\n角色说明'
  await writeFile(file, markdown)
  expect((await loadRunProfiles(space)).dev).toMatchObject({ allowBash: true, skills: ['review'], instructions: '角色说明' })
  await writeFile(file, markdown.replace('allowBash: true', 'allowBash: yes'))
  await expect(loadRunProfiles(space)).rejects.toThrow('allowBash 必须是 boolean')
})

it('新运行读取最新配置并隔离其对象，workflow函数保留且容器不共享', async () => {
  const { root, space, stores } = await fixture()
  const fn = async () => {}
  const workflow: WorkflowDefinition = { id: 'test', version: '1', title: '旧标题', stages: [], nodes: [{ id: 'script', kind: 'script', title: '脚本', run: fn }] }
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, contextBudgetTokens: 1234 }))
  const runtime = await loadRunRuntime(space, workflow)
  workflow.title = '新标题'
  workflow.nodes[0]!.title = '修改'
  stores.config.contextBudgetTokens = 99
  expect(runtime.space.stores.config.contextBudgetTokens).toBe(1234)
  expect(runtime.workflow.title).toBe('旧标题')
  expect(runtime.workflow.nodes[0]).toMatchObject({ title: '脚本', run: fn })
})

it('knowledge未配置有默认源，配置显式空数组保持空，非法kind与重复ID拒绝', async () => {
  const { space } = await fixture()
  expect(knowledgeForRun(space).length).toBeGreaterThan(0)
  space.stores.config.knowledge = []
  expect(knowledgeForRun(space)).toEqual([])
  space.stores.config.knowledge = [{ id: 'bad', kind: 'unknown' }]
  expect(() => knowledgeForRun(space)).toThrow('未知知识源类型')
  space.stores.config.knowledge = [{ id: 'same', kind: 'workspace' }, { id: 'same', kind: 'workspace' }]
  expect(() => knowledgeForRun(space)).toThrow('ID 为空或重复')
})

it('知识源配置重映射sourceId，拒绝错误类型的选项', async () => {
  const { space } = await fixture()
  space.stores.config.knowledge = [{ id: 'project-history', kind: 'workspace' }]
  const sources = knowledgeForRun(space)
  expect(sources.map((source) => source.id)).toEqual(['project-history'])
  space.stores.config.knowledge = [{ id: 'search', kind: 'grep', options: { ignore: 'not-an-array' } }]
  expect(() => knowledgeForRun(space)).toThrow('ignore 必须是字符串数组')
  space.stores.config.knowledge = [{ id: 'search', kind: 'grep', options: { unsafe: true } }]
  expect(() => knowledgeForRun(space)).toThrow('不支持的选项')
})
