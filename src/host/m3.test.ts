import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attributeDefect, createInsights, getDefect, initProject, reportDefect, saveEvalCase, waitDefectAttribution, waitEvalRun,
  type AgentProfile, type EvalCase, type HarnessAdapter, type RunState,
} from '@taktflow/core'
import { createLocalSandboxProvider } from '@taktflow/sandbox'
import { FsBindings } from './bindings.js'
import type { DefineTool, ToolDefinition, Agent, SubagentActivationSpec, SubagentResult, ToolExecutionContext } from './dsh-types.js'
import { createM3Service, DEFECT_CONFIRM_LABEL, DEFECT_EDIT_LABEL, DEFECT_REJECT_LABEL } from './m3.js'
import { createM3RuntimeFactory } from './m3-runtime.js'
import { InMemoryPermissionRegistry, createWriteGuard } from './permissions.js'
import { DshRolePresets } from './presets.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import { registerRoutes } from './routes.js'
import { registerLeadTools, type LeadToolResult } from './lead/tools.js'
import type { Ownership, SpaceHandle, TaktflowService } from './types.js'
const roots: string[] = []
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(closes.splice(0).map((fn) => fn())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
async function waitFor(test: () => boolean | Promise<boolean>) { const end=Date.now()+5000; while(Date.now()<end) { if(await test())return; await new Promise(r=>setTimeout(r,5)) } throw new Error('等待超时') }
const candidate = { introducedAt: { origin: 'unknown', evidence: ['缺少可定位的历史产物'] }, missedBy: [], confidence: 0.3, suggestions: [] }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-m3-test-'))); roots.push(root)
  const stores=await initProject(root), req=await stores.workspaces.createRequirement({title:'M3验收'})
  const space: SpaceHandle={root,stores,insights:createInsights(stores)}
  const ctx=new FakeHostContext(); ctx.provide('agentPresets',ctx.agentPresets)
  let leased=true, online=true
  const ownership={ensureLease:vi.fn(async()=>{if(!leased)throw new Error('lease lost')})} as unknown as Ownership
  const bindings=new FsBindings(ownership)
  const parent:Agent={id:'lead',options:{provider:'app',model:'model-a'},session:{header:{id:'lead',cwd:root,agentPreset:'taktflow'}},followup(){},inject(){}}
  const agents=new Map<string,Agent>([[parent.id,parent]])
  ctx.agents.get=id=>id===parent.id&&!online?undefined:agents.get(id)
  ctx.agents.roots=()=>online?[parent]:[]
  await bindings.bind(space,req.id,parent.id,{type:'human',id:'bound-person'})
  const permissions=new InMemoryPermissionRegistry()
  const presets=new DshRolePresets(ctx)
  const activations:SubagentActivationSpec[]=[]
  let respond:(spec:SubagentActivationSpec)=>Promise<SubagentResult>=async()=>({stopReason:'completed',output:[],structured:candidate})
  ctx.subagents.startActivation=async spec=>{
    activations.push(spec)
    const child:Agent={...parent,id:spec.childId!,options:{...parent.options,...spec.request.agentOptions},session:{header:{id:spec.childId!,cwd:spec.request.cwd}}}
    agents.set(child.id,child)
    const result=respond(spec)
    return {childId:child.id,result,dispose:async()=>{agents.delete(child.id)}}
  }
  const service=createM3Service({ctx,spaces:{open:async()=>space},ownership,presets,permissions,bindings})
  closes.push(()=>service.dispose())
  const actor={type:'agent' as const,role:'lead',harness:'dsh-host',onBehalfOf:'bound-person'}
  const exec={agent:parent,signal:new AbortController().signal} as ToolExecutionContext
  async function report(){return service.report(space,req.id,{title:'线上故障',description:'边界错误',severity:'major',reason:'用户报告'},actor)}
  async function attributed(){const defect=await report(); await service.attribute(space,req.id,defect.id,actor); await waitDefectAttribution(stores,req.id,defect.id); await waitFor(async()=> {const current=await getDefect(stores,req.id,defect.id);return current.status==='attributed'&&!current.attributing}); await waitFor(()=>agents.size===1); return defect.id}
  return {root,stores,req,space,ctx,parent,agents,ownership,bindings,permissions,presets,activations,service,actor,exec,report,attributed,
    setResponse:(fn:typeof respond)=>{respond=fn},setLease:(value:boolean)=>{leased=value},setOnline:(value:boolean)=>{online=value}}
}

describe('M3 身份、后台和原生确认',()=>{
  it('Lead代录保留agent与绑定人，真实归因/确认落盘并通过审计',async()=>{
    const f=await fixture();const id=await f.attributed()
    expect((await getDefect(f.stores,f.req.id,id)).reportedBy).toEqual(f.actor)
    f.ctx.userQuestions!.ask=async request=>({answers:[{id:request.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]})
    const result=await f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'wrong-config-user')
    expect(result.confirmed).toBe(true)
    expect((await getDefect(f.stores,f.req.id,id)).attribution?.confirmed?.by).toEqual({type:'human',id:'bound-person',via:'dsh:user-questions'})
    expect((await f.stores.events.verify(`defect-${f.req.id}`)).ok).toBe(true)
  })
  it('human冒充Lead和错误onBehalfOf不落盘，失租不能report',async()=>{
    const f=await fixture();const request={title:'x',description:'x',severity:'minor' as const,reason:'x'}
    await expect(f.service.report(f.space,f.req.id,request,{type:'human',id:'bound-person'})).rejects.toThrow('agent')
    await expect(f.service.report(f.space,f.req.id,request,{...f.actor,onBehalfOf:'other'})).rejects.toThrow('agent')
    f.setLease(false);await expect(f.report()).rejects.toThrow('lease lost')
    expect(await f.service.listDefects(f.space,f.req.id)).toEqual([])
  })
  it('attribute立即返回且同缺陷重复请求不启动第二auditor',async()=>{
    const f=await fixture(), gate=deferred<SubagentResult>();f.setResponse(()=>gate.promise)
    const d=await f.report(), initial=await f.service.attribute(f.space,f.req.id,d.id,f.actor)
    expect(initial.attributing).toBe(true)
    await expect(f.service.attribute(f.space,f.req.id,d.id,f.actor)).rejects.toThrow('正在')
    await waitFor(()=>f.activations.length===1)
    const blocked=await f.service.getCommands(f.stores).run('defect.confirm',{requirementId:f.req.id,defectId:d.id},{actor:{type:'human',id:'bound-person'},reason:'确认'})
    expect(blocked.ok).toBe(false)
    gate.resolve({stopReason:'completed',output:[],structured:candidate})
    await waitDefectAttribution(f.stores,f.req.id,d.id)
    expect((await getDefect(f.stores,f.req.id,d.id)).status).toBe('attributed')
  })
  it('两张同时回答的卡片只能确认一次，不能覆盖首个人工审计',async()=>{
    const f=await fixture(), id=await f.attributed(),gate=deferred<void>();let asked=0
    f.ctx.userQuestions!.ask=async request=>{asked++;await gate.promise;return{answers:[{id:request.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]}}
    const first=f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')
    const second=f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')
    const settled=Promise.allSettled([first,second])
    await waitFor(()=>asked===2);gate.resolve()
    const results=await settled
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const after=await getDefect(f.stores,f.req.id,id);expect(after.status).toBe('confirmed')
    const record=(await f.stores.workspaces.listArtifacts(f.req.id)).find(r=>r.path===`defects/${id}.attribution.json`)!
    expect(record.versions).toHaveLength(2)
  })
  it.each(['cancel','offline','lease','stale'])('等待卡片期间%s不能确认',async mode=>{
    const f=await fixture(),id=await f.attributed(),controller=new AbortController()
    f.ctx.userQuestions!.ask=async request=>{
      if(mode==='cancel')controller.abort()
      if(mode==='offline')f.setOnline(false)
      if(mode==='lease')f.setLease(false)
      if(mode==='stale')await f.stores.workspaces.writeArtifact({ref:{workspace:f.req.id,path:`defects/${id}.attribution.json`},kind:'defect',author:{type:'system',id:'test'},content:JSON.stringify({...((await getDefect(f.stores,f.req.id,id)).attribution!),confidence:0.7})})
      return{answers:[{id:request.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]}
    }
    await expect(f.service.confirmWithCard({...f.exec,signal:controller.signal},f.space,f.req.id,id,'ignored')).rejects.toBeDefined()
    expect((await getDefect(f.stores,f.req.id,id)).status).toBe('attributed')
  })
  it.each(['{}','{"note":"只有备注"}','{"suggestions":[]}','{"note":"修改","introducedAt":null}'])('修改后确认拒绝无效修改%s',async custom=>{
    const f=await fixture(),id=await f.attributed()
    f.ctx.userQuestions!.ask=async r=>({answers:[{id:r.questions[0]!.id,selected:[DEFECT_EDIT_LABEL],custom}]})
    await expect(f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')).rejects.toThrow()
    expect((await getDefect(f.stores,f.req.id,id)).status).toBe('attributed')
  })
  it('人工修改确实入账；驳回不确认，失租驳回不追加事件',async()=>{
    const f=await fixture(),id=await f.attributed()
    f.ctx.userQuestions!.ask=async r=>({answers:[{id:r.questions[0]!.id,selected:[DEFECT_EDIT_LABEL],custom:JSON.stringify({note:'人工补充',suggestions:[{target:{kind:'prompt',ref:'dev'},change:'增加边界'}]})}]})
    await f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')
    expect((await getDefect(f.stores,f.req.id,id)).attribution?.confirmed).toMatchObject({edited:true,note:'人工补充'})
    const other=await f.attributed()
    f.ctx.userQuestions!.ask=async r=>({answers:[{id:r.questions[0]!.id,selected:[DEFECT_REJECT_LABEL]}]})
    expect((await f.service.confirmWithCard(f.exec,f.space,f.req.id,other,'ignored')).rejected).toBe(true)
    expect((await getDefect(f.stores,f.req.id,other)).status).toBe('attributed')
    const before=(await f.stores.events.read(`defect-${f.req.id}`)).length
    f.ctx.userQuestions!.ask=async r=>{f.setLease(false);return{answers:[{id:r.questions[0]!.id,selected:[DEFECT_REJECT_LABEL]}]}}
    await expect(f.service.confirmWithCard(f.exec,f.space,f.req.id,other,'ignored')).rejects.toThrow('lease lost')
    expect((await f.stores.events.read(`defect-${f.req.id}`)).length).toBe(before)
  })
  it('模型返回后的失租阻止归因落盘，shutdown等待core收尾',async()=>{
    const f=await fixture(),gate=deferred<SubagentResult>();f.setResponse(()=>gate.promise)
    const d=await f.report();await f.service.attribute(f.space,f.req.id,d.id,f.actor);await waitFor(()=>f.activations.length===1)
    f.setLease(false);gate.resolve({stopReason:'completed',output:[],structured:candidate})
    await waitDefectAttribution(f.stores,f.req.id,d.id).catch(()=>{})
    expect((await getDefect(f.stores,f.req.id,d.id)).status).toBe('open')
    await expect(f.service.dispose()).rejects.toThrow('M3 后台执行或清理失败')
  })
})

async function replayFixture(f:Awaited<ReturnType<typeof fixture>>) {
  await writeFile(path.join(f.stores.paths.agents,'coder.md'),'---\nrole: coder\ntitle: coder\nharness: { harness: dsh-host, model: model-a }\nskills: [sample]\nwriteScope: []\n---\nBASE-INSTRUCTION')
  for(const [dir,content] of [['skills/sample','BASE-SKILL'],['variant-skills/sample','VARIANT-SKILL']]){
    const folder=path.join(f.root,dir!);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'SKILL.md'),`---\nname: sample\ndescription: 示例\n---\n${content}`)
  }
  // initProject 的默认技能目录可能是 legacy；使用真实 paths。
  await mkdir(path.join(f.stores.paths.skills,'sample'),{recursive:true})
  await writeFile(path.join(f.stores.paths.skills,'sample','SKILL.md'),'---\nname: sample\ndescription: 示例\n---\nBASE-SKILL')
  await writeFile(path.join(f.root,'variant-profile.md'),'---\nrole: coder\ntitle: coder\nharness: { harness: dsh-host, model: model-a }\nskills: [sample]\nwriteScope: []\n---\nVARIANT-INSTRUCTION')
  const run:RunState={runId:'source-1',workflowId:'source',workflowVersion:'1',requirementId:f.req.id,status:'succeeded',startedAt:new Date().toISOString(),args:{},nodes:{task:{id:'task',status:'succeeded',attempts:1,outputs:[]}},expansions:[]}
  await f.stores.runs.create(run,{id:'source',title:'来源',version:'1',stages:[],nodes:[]})
  const value:EvalCase={id:'frozen-case',title:'回放',target:{kind:'node',workflowId:'source',nodeId:'task'},source:{kind:'history',runId:run.runId,nodeId:'task'},node:{id:'task',kind:'agent',title:'回放',role:'coder',needs:[],prompt:'BASE-PROMPT',writeScope:[],outputs:[]},inputs:[],grading:{checks:['核对事实']},createdAt:new Date().toISOString()}
  await saveEvalCase(f.stores,value)
  return value
}

describe('M3 原生运行时与真实core回放',()=>{
  it('baseline/变体使用各自冻结profile/skill/prompt，并以不同实际模型评分',async()=>{
    const f=await fixture(),value=await replayFixture(f);await writeFile(path.join(f.root,'variant-prompt.md'),'VARIANT-PROMPT')
    const seen:Array<{instruction:string;skill:string;prompt:string;model?:string}>=[]
    f.setResponse(async spec=>{
      const preset=f.ctx.presets.find(p=>p.id===spec.request.agentPreset)!
      const role=preset.plugins!.find(p=>(p as {name?:string}).name==='taktflow/role') as {config:{role:string;instructions:string;skillSnapshot:Array<{content:string}>}}
      if(role.config.role==='evaluator')return{stopReason:'completed',output:[],structured:{checks:[{id:'c1',criterion:'核对事实',pass:true,evidence:'冻结输出已核对'}],score:100,reason:'通过'}}
      seen.push({instruction:role.config.instructions,skill:role.config.skillSnapshot[0]!.content,prompt:spec.request.prompt.map(b=>'text'in b?b.text:'').join(''),model:spec.request.agentOptions?.model})
      return{stopReason:'completed',output:[{type:'text',text:'完成'}]}
    })
    const response=await f.service.getCommands(f.stores).run('eval.run',{target:value.target,judge:{harness:'dsh-host',model:'model-b'},variants:[{id:'changed',label:'变体',profileFile:'variant-profile.md',skillsDir:'variant-skills',promptFile:'variant-prompt.md'}]},{actor:{type:'human',id:'bound-person'},reason:'验证改进'})
    expect(response.ok,response.message).toBe(true)
    const run=await waitEvalRun(f.stores,(response.result as {id:string}).id)
    expect(run.results.map(r=>r.error)).toEqual([undefined,undefined])
    expect(run.results.every(r=>r.pass)).toBe(true)
    expect(seen.map(s=>[s.instruction,s.skill])).toEqual([['BASE-INSTRUCTION','BASE-SKILL'],['VARIANT-INSTRUCTION','VARIANT-SKILL']])
    expect(seen[1]!.prompt).toContain('VARIANT-PROMPT');expect(seen[1]!.prompt).not.toContain('BASE-INSTRUCTION')
  })
  it('被测模型缺省继承App时，显式同模型judge也不得假称独立判分',async()=>{
    const f=await fixture(),value=await replayFixture(f)
    const file=path.join(f.stores.paths.agents,'coder.md');await writeFile(file,(await readFile(file,'utf8')).replace(', model: model-a',''))
    f.setResponse(async()=>({stopReason:'completed',output:[{type:'text',text:'完成'}]}))
    const response=await f.service.getCommands(f.stores).run('eval.run',{target:value.target,judge:{harness:'dsh-host',model:'model-a'},variants:[{id:'baseline',label:'基线'}]},{actor:{type:'human',id:'bound-person'},reason:'验证独立模型'})
    expect(response.ok,response.message).toBe(true)
    const run=await waitEvalRun(f.stores,(response.result as {id:string}).id)
    expect(run.results[0]!.pass).toBe(false);expect(run.results[0]!.error).toContain('实际模型必须不同')
  })
  it('临时目录读写守卫、实际模型核对及关闭后的拒绝',async()=>{
    const f=await fixture(),shutdown=new AbortController()
    const factory=createM3RuntimeFactory({...f,shutdown:shutdown.signal})
    const engine=await factory.create(f.space,f.req.id)
    closes.push(()=>factory.dispose())
    const cwd=await realpath(await mkdtemp(path.join(tmpdir(),'takt-m3-isolation-')));roots.push(cwd)
    f.setResponse(async spec=>{
      const guard=createWriteGuard(f.permissions), child=f.agents.get(spec.childId!)!
      expect(guard({name:'read',agent:child,arguments:{file_path:path.join(f.root,'takt.config.json')}} as never)).toContain('拒绝')
      expect(guard({name:'write',agent:child,arguments:{file_path:path.join(cwd,'x')}} as never)).toContain('只读')
      expect(guard({name:'read',agent:child,arguments:{file_path:path.join(cwd,'x')}} as never)).toBeUndefined()
      return{stopReason:'completed',output:[{type:'text',text:'```json\n[1]\n```'}]}
    })
    const result=await engine.deps.harnesses['dsh-host']!.run({cwd,prompt:'输出数组',env:{TAKT_ROLE:'auditor'},tools:{writeScope:[]},resultSchema:{type:'array',items:{type:'integer'}}},()=>{})
    expect(result.structured).toEqual([1]);expect(f.activations[0]!.request.outputSchema).toBeUndefined()
    await engine.dispose()
    await expect(engine.deps.harnesses['dsh-host']!.run({cwd,prompt:'x',env:{TAKT_ROLE:'auditor'}},()=>{})).rejects.toBeDefined()
  })
})

describe('M3 生命周期与边界',()=>{
  it('原生卡片与panel同时确认共用互斥，agent不能使用confirm命令',async()=>{
    const f=await fixture(),id=await f.attributed(),gate=deferred<void>();let asked=false
    f.ctx.userQuestions!.ask=async r=>{asked=true;await gate.promise;return{answers:[{id:r.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]}}
    const card=f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')
    await waitFor(()=>asked)
    const registry=f.service.getCommands(f.stores)
    expect((await registry.run('defect.confirm',{requirementId:f.req.id,defectId:id},{actor:f.actor,reason:'agent尝试'})).ok).toBe(false)
    const panel=await registry.run('defect.confirm',{requirementId:f.req.id,defectId:id},{actor:{type:'human',id:'panel-person',via:'dsh-web'},reason:'面板确认'})
    expect(panel.ok,panel.message).toBe(true)
    gate.resolve();await expect(card).rejects.toThrow('过期')
    expect((await getDefect(f.stores,f.req.id,id)).attribution?.confirmed?.by).toMatchObject({id:'panel-person',via:'dsh-web'})
  })
  it('容量排队后重新校验同一Lead，离线不借用其他根',async()=>{
    const f=await fixture(),factory=createM3RuntimeFactory({...f,shutdown:new AbortController().signal})
    closes.push(()=>factory.dispose());const engine=await factory.create(f.space,f.req.id)
    let calls=0
    f.ctx.subagents.startActivation=async()=>{calls++;f.setOnline(false);throw Object.assign(new Error('full'),{code:'ACTIVATION_LIMIT_REACHED'})}
    await expect(engine.deps.harnesses['dsh-host']!.run({cwd:f.root,prompt:'x',env:{TAKT_ROLE:'auditor'}},()=>{})).rejects.toThrow('在线 Lead')
    expect(calls).toBe(1);expect(f.ctx.presets).toHaveLength(0)
  })
  it('拒绝子目录Lead、不同preset及单向绑定，不忽略配置的模型',async()=>{
    const f=await fixture(),factory=createM3RuntimeFactory({...f,shutdown:new AbortController().signal})
    closes.push(()=>factory.dispose());await mkdir(path.join(f.root,'nested'))
    const header=f.parent.session.header as {cwd:string;agentPreset:string}
    header.cwd=path.join(f.root,'nested')
    await expect(factory.create(f.space,f.req.id)).rejects.toThrow('空间根')
    header.cwd=f.root;header.agentPreset='standard'
    await expect(factory.create(f.space,f.req.id)).rejects.toThrow('taktflow')
    header.agentPreset='taktflow'
    await writeFile(path.join(f.stores.paths.agents,'auditor.md'),'---\nrole: auditor\nharness: { harness: dsh-host, model: chosen-model, effort: high }\nwriteScope: []\nskills: []\n---\n只读归因')
    const engine=await factory.create(f.space,f.req.id)
    expect(engine.deps.profiles.auditor?.harness).toMatchObject({model:'chosen-model',effort:'high'})
    f.bindings.bySession=async()=>undefined
    await expect(engine.deps.harnesses['dsh-host']!.run({cwd:f.root,prompt:'x',env:{TAKT_ROLE:'auditor'}},()=>{})).rejects.toThrow('在线 Lead')
  })
  it('实际模型不符会失败并释放确认已停止的child权限和preset',async()=>{
    const f=await fixture(),factory=createM3RuntimeFactory({...f,shutdown:new AbortController().signal})
    closes.push(()=>factory.dispose());const engine=await factory.create(f.space,f.req.id)
    const original=f.ctx.subagents.startActivation
    f.ctx.subagents.startActivation=async spec=>{const activation=await original(spec);const child=f.agents.get(spec.childId!)!;f.agents.set(child.id,{...child,options:{model:'different'}});return activation}
    await expect(engine.deps.harnesses['dsh-host']!.run({cwd:f.root,prompt:'x',model:'wanted',env:{TAKT_ROLE:'auditor'}},()=>{})).rejects.toThrow('实际模型')
    expect(f.permissions.lookup(f.activations[0]!.childId!)).toBeUndefined();expect(f.ctx.presets).toHaveLength(0)
  })
  it('activation停止失败保留守卫，dispose重试并显式报告清理失败',async()=>{
    const f=await fixture(),factory=createM3RuntimeFactory({...f,shutdown:new AbortController().signal})
    closes.push(()=>factory.dispose());const engine=await factory.create(f.space,f.req.id)
    const original=f.ctx.subagents.startActivation;let disposals=0
    f.ctx.subagents.startActivation=async spec=>{const a=await original(spec);return{...a,dispose:async()=>{disposals++;if(disposals===1)throw new Error('stop failed');await a.dispose()}}}
    await expect(engine.deps.harnesses['dsh-host']!.run({cwd:f.root,prompt:'x',env:{TAKT_ROLE:'auditor'}},()=>{})).rejects.toThrow('清理失败')
    expect(f.permissions.lookup(f.activations[0]!.childId!)).toBeDefined()
    await expect(engine.dispose()).rejects.toThrow('清理曾发生失败')
    expect(disposals).toBe(2);expect(f.permissions.lookup(f.activations[0]!.childId!)).toBeUndefined();expect(f.ctx.presets).toHaveLength(0)
  })
  it('关闭中止等待中的原生卡片且不能在关闭后写入确认',async()=>{
    const f=await fixture(),id=await f.attributed(),gate=deferred<void>();let asked=false
    f.ctx.userQuestions!.ask=async r=>{asked=true;await gate.promise;return{answers:[{id:r.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]}}
    const card=f.service.confirmWithCard(f.exec,f.space,f.req.id,id,'ignored')
    await waitFor(()=>asked);await f.service.dispose();gate.resolve()
    await expect(card).rejects.toBeDefined();expect((await getDefect(f.stores,f.req.id,id)).status).toBe('attributed')
  })
})

describe('面板M3路由真实接线',()=>{
  it('defect.report / command.run attribute / defect.confirm和读接口保留M3协议与宿主身份',async()=>{
    const f=await fixture()
    registerRoutes(f.ctx,{m3:f.service,ownership:f.ownership,spaces:{roots:async()=>[f.root],open:async()=>f.space}} as unknown as TaktflowService,{user:'bound-person'})
    const post=async(p:string,params:Record<string,string>,body:unknown)=>{
      const response=await f.ctx.routes.find(r=>r.path==='/api/taktflow.op')!.fetch(new Request('http://localhost/api/taktflow.op',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({space:f.root,p,params,body})}))
      return{status:response.status,body:await response.json() as {ok:boolean;data:Record<string,unknown>}}
    }
    const reported=await post('defect.report',{id:f.req.id},{requirementId:'forged',title:'panel',description:'failure',severity:'major',reason:'人录入',by:{type:'agent',role:'forged'}})
    expect(reported.status).toBe(200);expect(reported.body.data.reportedBy).toEqual({type:'human',id:'bound-person',via:'dsh-web'})
    const id=reported.body.data.id as string
    const started=await post('command.run',{id:'defect.attribute'},{input:{requirementId:f.req.id,defectId:id},reason:'面板归因'})
    expect(started.body.data.ok).toBe(true)
    await waitDefectAttribution(f.stores,f.req.id,id)
    await waitFor(()=>f.ctx.presets.length===0)
    const read=async(p:string,params:Record<string,string>)=>{
      const url=new URL('http://localhost/api/taktflow');url.search=new URLSearchParams({space:f.root,p,...params}).toString()
      const response=await f.ctx.routes.find(r=>r.path==='/api/taktflow')!.fetch(new Request(url))
      expect(response.status).toBe(200);return response.json() as Promise<{ok:boolean;data:unknown}>
    }
    expect((await read('defects',{id:f.req.id})).data).toMatchObject([{id,status:'attributed'}])
    expect((await read('eval.scorecards',{by:'recipe'})).ok).toBe(true)
    const confirmed=await post('defect.confirm',{id:f.req.id,defectId:id},{reason:'人确认',by:{type:'agent'}})
    expect(confirmed.status).toBe(200)
    expect((await getDefect(f.stores,f.req.id,id)).attribution?.confirmed?.by).toEqual({type:'human',id:'bound-person',via:'dsh-web'})
  })
})

describe('Lead工具的M3闭环',()=>{
  it('report/attribute/why/defects/scorecard真实接线，并把人工修改错误映射为可理解的参数错误',async()=>{
    const f=await fixture()
    const service={m3:f.service,bindings:f.bindings,spaces:{forSession:async()=>f.space}} as unknown as TaktflowService
    const tools=registerLeadTools(((options)=>options as unknown as ToolDefinition) as DefineTool,service,{ctx:{agents:f.ctx.agents},user:'different-config-user'})
    expect(tools).toHaveLength(7)
    const call=async(name:string,args:Record<string,unknown>)=>await tools.find(t=>t.name===name)!.execute(args,f.exec) as LeadToolResult
    expect(await call('takt_trace',{action:'defects'})).toMatchObject({ok:true,count:0})
    const reported=await call('takt_trace',{action:'report',title:'线上边界bug',description:'输入为空出错',severity:'major',reason:'用户报告',author:{type:'human',id:'forged'}})
    expect(reported.ok).toBe(true)
    const id=reported.defectId as string
    expect((await getDefect(f.stores,f.req.id,id)).reportedBy).toMatchObject({type:'agent',role:'lead',onBehalfOf:'bound-person'})
    const before=await call('takt_trace',{action:'why',defectId:id})
    expect(before.next_actions.join(' ')).toContain('attribute')
    expect((await call('takt_trace',{action:'attribute',defectId:id})).ok).toBe(true)
    await waitDefectAttribution(f.stores,f.req.id,id)
    await waitFor(()=>f.ctx.presets.length===0)
    const why=await call('takt_trace',{action:'why',defectId:id})
    expect(why).toMatchObject({ok:true,attributionState:'candidate',confirmed:false})
    expect(why.introducedAt).toEqual(candidate.introducedAt)
    f.ctx.userQuestions!.ask=async r=>({answers:[{id:r.questions[0]!.id,selected:[DEFECT_EDIT_LABEL],custom:'{}'}]})
    const invalid=await call('takt_ask_human',{defectId:id})
    expect(invalid.error).toMatchObject({code:'TAKT_INVALID_INPUT'})
    expect(invalid.error?.message).toContain('note')
    f.ctx.userQuestions!.ask=async r=>({answers:[{id:r.questions[0]!.id,selected:[DEFECT_CONFIRM_LABEL]}]})
    expect(await call('takt_ask_human',{defectId:id})).toMatchObject({ok:true,confirmed:true})
    expect(await call('takt_trace',{action:'why',defectId:id})).toMatchObject({ok:true,attributionState:'confirmed',confirmed:true})
    expect(await call('takt_trace',{action:'scorecard',by:'skill'})).toMatchObject({ok:true,scope:'space'})
  })
})

describe('M3 原生模型选择与启动诊断', () => {
  it('默认外部 CLI auditor 档案切到 App 时不移植 high，实际走父会话模型', async () => {
    const f = await fixture()
    const id = await f.attributed()
    expect(f.activations[0]!.request.agentOptions).toBeUndefined()
    expect((await getDefect(f.stores, f.req.id, id)).status).toBe('attributed')
    expect(f.ctx.listeners).toHaveLength(0)
  })

  it('显式 dsh-host effort 原样传递，发布前错误也携带脱敏 code/message 返回', async () => {
    const f = await fixture()
    await writeFile(path.join(f.stores.paths.agents, 'auditor.md'), '---\nrole: auditor\nharness: { harness: dsh-host, effort: high }\nwriteScope: []\nskills: []\n---\n独立归因')
    const factory = createM3RuntimeFactory({ ...f, shutdown: new AbortController().signal })
    closes.push(() => factory.dispose())
    const engine = await factory.create(f.space, f.req.id)
    expect(engine.deps.profiles.auditor!.harness).toEqual({ harness: 'dsh-host', effort: 'high' })
    f.setResponse(async (spec) => {
      expect(spec.request.agentOptions).toEqual({ reasoningEffort: 'high' })
      const error = Object.assign(new Error('不支持 high；secret-hidden'), { code: 'UNSUPPORTED_REASONING_EFFORT' })
      for (const listener of f.ctx.listeners.filter((item) => item.event === 'agent/error')) {
        (listener.listener as (...args: unknown[]) => void)({ agent: f.agents.get(spec.childId!), error, turn: 0, step: 0 })
      }
      return { stopReason: 'error', output: [] }
    })
    const result = await engine.deps.harnesses['dsh-host']!.run({ cwd: f.root, prompt: '最小启动', effort: 'high', env: { TAKT_ROLE: 'auditor', SECRET_KEY: 'secret-hidden' } }, () => {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('UNSUPPORTED_REASONING_EFFORT')
    expect(result.error).toContain('[REDACTED]')
    expect(result.error).not.toContain('secret-hidden')
    expect(f.ctx.listeners).toHaveLength(0)
  })

  it('从本 child 的 turn/end structured error 恢复错误，不串用其它会话', async () => {
    const f = await fixture()
    const factory = createM3RuntimeFactory({ ...f, shutdown: new AbortController().signal })
    closes.push(() => factory.dispose())
    const engine = await factory.create(f.space, f.req.id)
    f.setResponse(async (spec) => {
      for (const item of f.ctx.listeners.filter((record) => record.event === 'session/event')) {
        const listener = item.listener as (...args: unknown[]) => void
        listener({ id: 'unrelated' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'WRONG', message: 'other-session' } } } })
        listener({ id: spec.childId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_FAILURE', message: '真实失败' } } } })
      }
      return { stopReason: 'error', output: [] }
    })
    const result = await engine.deps.harnesses['dsh-host']!.run({ cwd: f.root, prompt: '最小启动', env: { TAKT_ROLE: 'auditor' } }, () => {})
    expect(result.error).toBe('[MODEL_FAILURE] 真实失败')
    expect(f.ctx.listeners).toHaveLength(0)
  })
})

describe('M3 原生深冻结结果与 core 归因规范化', () => {
  it.each([false, true])('真实节点归因可规范化 runId，SDK 原对象不被修改（已有 runId=%s）', async (hasRunId) => {
    const f = await fixture()
    const runId = 'source-frozen-attribution'
    const source: RunState = {
      runId, workflowId: 'frozen-source', workflowVersion: '1', requirementId: f.req.id,
      status: 'succeeded', startedAt: new Date().toISOString(), args: {}, expansions: [],
      nodes: {
        implement: { id: 'implement', status: 'succeeded', attempts: 1, outputs: [] },
        'review-code': { id: 'review-code', status: 'succeeded', attempts: 1, outputs: [] },
      },
    }
    await f.stores.runs.create(source, {
      id: 'frozen-source', title: '归因来源', version: '1', stages: [],
      nodes: [
        { id: 'implement', kind: 'agent', title: '实现', needs: [], role: 'dev' },
        { id: 'review-code', kind: 'agent', title: '评审', needs: ['implement'], role: 'reviewer' },
      ],
    })
    const structured = Object.freeze({
      introducedAt: Object.freeze({ origin: 'implementation', nodeId: 'implement', ...(hasRunId ? { runId } : {}), evidence: Object.freeze(['实现节点的空输入检查缺失']) }),
      missedBy: Object.freeze([Object.freeze({ nodeId: 'review-code', reason: 'reviewed_but_missed', evidence: Object.freeze(['评审未发现空输入分支']) })]),
      confidence: 0.9, suggestions: Object.freeze([]),
    })
    const original = JSON.stringify(structured)
    f.setResponse(async () => ({ stopReason: 'completed', output: [], structured }))
    const defect = await f.report()
    await f.service.attribute(f.space, f.req.id, defect.id, f.actor)
    const attributed = await waitDefectAttribution(f.stores, f.req.id, defect.id)
    const errors = (await f.stores.events.read(`defect-${f.req.id}`)).filter((event) => event.type === 'log' && (event.data as { level?: string }).level === 'error')
    expect(attributed.status, JSON.stringify(errors)).toBe('attributed')
    expect(attributed.attribution?.introducedAt.runId).toBe(runId)
    expect(attributed.attribution?.missedBy[0]?.runId).toBe(runId)
    expect((await getDefect(f.stores, f.req.id, defect.id)).attribution).toEqual(attributed.attribution)
    expect((await f.stores.events.verify(`defect-${f.req.id}`)).ok).toBe(true)
    expect(JSON.stringify(structured)).toBe(original)
    expect(Object.isFrozen(structured)).toBe(true)
    expect(Object.isFrozen(structured.introducedAt)).toBe(true)
    expect(Object.isFrozen(structured.missedBy[0])).toBe(true)
    expect(structured.missedBy[0]).not.toHaveProperty('runId')
  })
})
