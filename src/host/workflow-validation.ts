/**
 * 发布包内的 workflow 源码校验适配层。
 *
 * 为什么需要：vendor 的 `workflow-source/src/validate.ts` 会 `require.resolve('tsx')`
 * 并 spawn 同目录的 `validate-runner.js`；发布包既没有 tsx 依赖，也没有该 runner，
 * 因此 API 的 workflow 读/写校验在真实安装环境必然失败。这里在不改 vendor、不装
 * 新依赖的前提下替换该模块：
 *
 * - 宿主先用已有的 typescript parser 给出语法诊断（错误位置准确）；
 * - 语法通过后启动 Node 24 原生子进程运行随包 `lib/workflow-validation-runner.js`，
 *   由它使用 `WorkflowFileLoader` 加载流程并生成快照；
 * - 保留原实现的 15 秒超时、8 MiB 响应上限和 FD3 传输协议。
 *
 * 调用方：构建时把 `@taktflow/workflow-source` 内部的 `./validate.js` 替换成本模块；
 * `createWorkflowStore` 的 document/get 与 routes 的 workflow 校验都走这里。
 * 失败语义：语法错误直接返回 diagnostics；runner 缺失、超时、超限或子进程失败都
 * 返回 error diagnostic，不抛异常、不回退到宿主内 evaluate。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { WorkflowDiagnostic, WorkflowSnapshot } from '@taktflow/core'
import { findBundledEntry } from '../workflows/loader.js'

export interface WorkflowValidation {
  snapshot?: WorkflowSnapshot
  diagnostics: WorkflowDiagnostic[]
}

/** 与 vendor 相同的失败边界。 */
const VALIDATION_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_STDERR_CHARS = 16_384

export async function validateWorkflowSource(file: string): Promise<WorkflowValidation> {
  const absolute = resolve(file)
  const source = await readFile(absolute, 'utf8')
  const syntax = syntaxDiagnostics(absolute, source)
  if (syntax.length > 0) return { diagnostics: syntax }

  const runner = findBundledEntry('workflow-validation-runner')
  if (runner === undefined) {
    return {
      diagnostics: [{
        severity: 'error',
        message: '发布包缺少 workflow 校验 runner（lib/workflow-validation-runner.js）；请重新构建插件',
      }],
    }
  }
  return runValidationProcess(runner, absolute)
}

/**
 * 只做语法诊断：语义/导入错误交给子进程的完整加载流程，避免宿主内执行未知模块。
 * `parseDiagnostics` 是 TS 编译器的语法错误列表，不含类型检查噪音。
 */
function syntaxDiagnostics(file: string, source: string): WorkflowDiagnostic[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const raw = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  return raw.map((diagnostic) => {
    const position = diagnostic.start === undefined
      ? undefined
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
    return {
      severity: 'error',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ...(position === undefined ? {} : { line: position.line + 1, column: position.character + 1 }),
    }
  })
}

/** 与 vendor validate.ts 相同的子进程协议：argv[2]=文件，FD3 返回 JSON，15 秒/8 MiB 上限。 */
function runValidationProcess(runner: string, file: string): Promise<WorkflowValidation> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [runner, file], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    })
    let response = ''
    let stderr = ''
    let timedOut = false
    let oversized = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, VALIDATION_TIMEOUT_MS)
    ;(child.stdio[3] as Readable).setEncoding('utf8').on('data', (data: string) => {
      response += data
      if (response.length > MAX_RESPONSE_BYTES) {
        oversized = true
        child.kill('SIGKILL')
      }
    })
    child.stderr!.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-MAX_STDERR_CHARS)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ diagnostics: [{ severity: 'error', message: `无法启动校验子进程：${error.message}` }] })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let message: string
      let stack = ''
      if (timedOut) message = 'workflow 加载超时（15 秒）'
      else if (oversized) message = 'workflow 快照超过 8 MiB 限制'
      else {
        try {
          const result = JSON.parse(response) as WorkflowValidation & { message?: string; stack?: string }
          if (code === 0 && result.snapshot) {
            resolveResult({ snapshot: result.snapshot, diagnostics: [] })
            return
          }
          message = result.message ?? `workflow 校验进程退出（${code}）`
          stack = result.stack ?? ''
        } catch {
          message = `workflow 校验进程未返回快照（${code}）：${stderr.trim()}`
        }
      }
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const position = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack + stderr)
      resolveResult({
        diagnostics: [{
          severity: 'error',
          message,
          ...(position === null ? {} : { line: Number(position[1]), column: Number(position[2]) }),
        }],
      })
    })
  })
}
