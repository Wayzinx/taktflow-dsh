import type {
  Agent,
  AgentPresetDefinition,
  ConnectionFetchRoute,
  Disposer,
  EffectBody,
  Fiber,
  HostContext,
  SkillRegistration,
  SubagentActivation,
  SubagentActivationSpec,
  SystemPromptSection,
  ToolDefinition,
  ToolGuard,
  UserQuestion,
  UserQuestionsRequest,
  UserQuestionsResult,
} from '../dsh-types.js'

interface RecordedEffect {
  label: string
  dispose: Disposer
  ready: Promise<void>
  active: boolean
  disposers: Disposer[]
}

/**
 * 单测用的假 dsh 上下文。
 *
 * 所有注册立即执行并记录参数；dispose() 逆序执行 effect 清理。异步 effect 会先
 * 等注册完成再清理；清理全部执行完再抛汇总错误，单个失败不会中断其它清理。
 */
export class FakeHostContext implements HostContext {
  readonly effects: RecordedEffect[] = []
  readonly provided: Array<{ name: string; value: unknown }> = []
  readonly routes: ConnectionFetchRoute[] = []
  readonly toolDefinitions: ToolDefinition[] = []
  readonly guards: ToolGuard[] = []
  readonly promptSections: SystemPromptSection[] = []
  readonly registeredSkills: SkillRegistration[] = []
  readonly activations: SubagentActivationSpec[] = []
  readonly questions: UserQuestion[][] = []
  readonly presets: AgentPresetDefinition[] = []
  readonly listeners: Array<{ event: string; listener: (...args: never[]) => void }> = []

  private readonly services = new Map<string, unknown>()
  private disposePromise: Promise<void> | undefined

  readonly connection: HostContext['connection']
  readonly tools: HostContext['tools']
  readonly subagents: HostContext['subagents']
  readonly agents: HostContext['agents']
  readonly agentPresets: HostContext['agentPresets']
  readonly userQuestions: HostContext['userQuestions']
  readonly systemPrompt: HostContext['systemPrompt']
  readonly skills: HostContext['skills']

  constructor() {
    this.connection = {
      fetch: {
        register: (route) => {
          return this.register(this.routes, route, 'connection.fetch.register')
        },
      },
    }
    this.tools = {
      register: (definition) => {
        return this.register(this.toolDefinitions, definition, 'tools.register')
      },
      guard: (guard) => {
        return this.register(this.guards, guard, 'tools.guard')
      },
    }
    this.subagents = {
      startActivation: async (spec): Promise<SubagentActivation> => {
        this.activations.push(spec)
        return {
          childId: spec.childId ?? `fake-child-${this.activations.length}`,
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
    this.agents = {
      get: (_id: string): Agent | undefined => undefined,
      roots: (): Agent[] => [],
    }
    this.agentPresets = {
      list: async () => this.presets.map(({ id, name, description, order }) => ({ id, name, description, order })),
      resolve: async (id) => {
        const definition = this.presets.find((preset) => preset.id === id)
        if (definition === undefined) throw new Error(`Unknown agent preset: ${id}`)
        return { id: definition.id }
      },
      register: async (definition) => {
        if (this.presets.some((preset) => preset.id === definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
        const dispose = this.register(this.presets, definition, 'agentPresets.register')
        return async () => { await dispose() }
      },
    }
    this.userQuestions = {
      ask: async (request: UserQuestionsRequest): Promise<UserQuestionsResult> => {
        this.questions.push([...request.questions])
        return { answers: [] }
      },
    }
    this.systemPrompt = {
      section: (section) => {
        return this.register(this.promptSections, section, 'systemPrompt.section')
      },
    }
    this.skills = {
      register: (skill) => {
        return this.register(this.registeredSkills, skill, 'skills.register')
      },
    }
  }

  private register<T>(entries: T[], entry: T, label: string): Disposer {
    return this.effect(() => {
      entries.push(entry)
      return () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    }, label)
  }

  inject(_deps: string[], callback: (ctx: HostContext) => void): Fiber & PromiseLike<Fiber> {
    const start = this.effects.length
    let failure: unknown
    try {
      callback(this)
    } catch (error) {
      failure = error
    }
    const children = this.effects.slice(start)
    const dispose = this.effect(() => async () => {
      const errors: unknown[] = []
      for (const child of [...children].reverse()) {
        try {
          await child.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      throwAggregate(errors, 'inject 清理失败')
    }, 'inject')
    // thenable 必须解析成普通 Fiber，否则 Promise 会再次解析自身。
    const fiber: Fiber = {
      dispose: async () => {
        await dispose()
      },
    }
    const ready = Promise.all(children.map((child) => child.ready)).then(() => {
      if (failure !== undefined) throw failure
      return fiber
    })
    void ready.catch(() => {})
    return Object.assign(ready, fiber)
  }

  effect(execute: () => EffectBody, label = 'anonymous'): Disposer {
    if (this.disposePromise !== undefined) throw new Error(`fake ctx 已 dispose，不能再注册 effect：${label}`)

    const record: RecordedEffect = {
      label,
      ready: Promise.resolve(),
      active: true,
      disposers: [],
      dispose: async () => {},
    }
    const collect = (disposer: Disposer) => {
      record.disposers.push(disposer)
    }
    try {
      const result = execute()
      if (typeof result === 'function') {
        collect(result)
      } else if (isPromise(result)) {
        record.ready = result.then(collect)
      } else if (isAsyncIterable(result)) {
        record.ready = (async () => {
          for await (const disposer of result) collect(disposer)
        })()
      } else if (isIterable(result)) {
        for (const disposer of result) collect(disposer)
      } else {
        throw new TypeError(`effect ${label} 返回了无效的清理值`)
      }
    } catch (error) {
      record.ready = Promise.reject(error)
    }
    // 保留原始失败给 dispose 汇总，同时避免未调用 dispose 时出现游离拒绝。
    void record.ready.catch(() => {})

    this.effects.push(record)
    let running: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      if (!record.active) return running ?? Promise.resolve()
      record.active = false
      const index = this.effects.indexOf(record)
      if (index >= 0) this.effects.splice(index, 1)
      running = (async () => {
        const errors: unknown[] = []
        try {
          await record.ready
        } catch (error) {
          errors.push(error)
        }
        for (const disposer of [...record.disposers].reverse()) {
          try {
            await disposer()
          } catch (error) {
            errors.push(error)
          }
        }
        throwAggregate(errors, `effect ${label} 清理失败`)
      })()
      return running
    }
    record.dispose = dispose
    return dispose
  }

  on(event: string, listener: (...args: never[]) => void): Disposer {
    return this.effect(() => {
      const record = { event, listener }
      this.listeners.push(record)
      return () => {
        const index = this.listeners.indexOf(record)
        if (index >= 0) this.listeners.splice(index, 1)
      }
    }, `on:${event}`)
  }

  get<T = unknown>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  provide(name: string, value: unknown): Disposer {
    if (this.services.has(name)) throw new Error(`service ${name} 已注册`)
    return this.effect(() => {
      this.provided.push({ name, value })
      this.services.set(name, value)
      return () => {
        this.services.delete(name)
        const index = this.provided.findIndex((entry) => entry.name === name)
        if (index >= 0) this.provided.splice(index, 1)
      }
    }, `provide:${name}`)
  }

  /** 测试专用：注入一个假服务（模拟 dsh 的其它 provider）。 */
  setService(name: string, value: unknown): void {
    this.services.set(name, value)
  }

  /** 逆序执行 effect 清理；可重复调用。清理错误汇总后抛出。 */
  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposePromise = (async () => {
      const errors: unknown[] = []
      for (const record of [...this.effects].reverse()) {
        try {
          await record.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      this.effects.length = 0
      throwAggregate(errors, 'fake ctx 清理失败')
    })()
    return this.disposePromise
  }

  get isDisposed(): boolean {
    return this.disposePromise !== undefined
  }
}

function throwAggregate(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

function isPromise(value: unknown): value is Promise<Disposer> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

function isIterable(value: unknown): value is Iterable<Disposer> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Disposer> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}
