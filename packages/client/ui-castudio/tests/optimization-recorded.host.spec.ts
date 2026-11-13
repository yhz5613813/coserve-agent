/** Recording-derived model replay over the production host/job/spawn/loop path.
 * This is an owner-local host integration test, not the CLI snapshot corpus.
 */
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from '../../../subagent/subagent/tests/local-activation.ts'
import * as Host from '../src/index.ts'

interface Recording {
  prompt: string
  call: { name: string; arguments: { code: string; rationale: string; changes: string[] } }
  expected: { jobKind:string;jobStatus:string;childToolResult:string;parentLifecycle:string[] }
}
const recordings = await Promise.all(['optimization-real-proposal.json','optimization-skill-proposal.json'].map(async name=>({ name,recording:JSON.parse(await readFile(new URL(`./fixtures/${name}`,import.meta.url),'utf8')) as Recording })))

/** Narrow API collaborator: parent creation still uses the production AgentLoop. */
class SessionApiFixture extends Service {
  parent?: Agent
  created?: { cwd:string;agentPreset:string }
  constructor(ctx:Context){super(ctx,'sessionController')}
  async create(input:{ cwd:string;agentPreset:string }){this.created=input;this.parent=await this.ctx.agentLoop.create(SessionId('recorded-optimization-parent'),{ provider:'recorded',model:'deepseek-recording' },{ cwd:input.cwd });return { sessionId:this.parent.id }}
  async rename(_input:object){return {}}
  async resolveAgent(id:string){if(this.parent?.id!==id)throw new Error('Unowned fixture session');return { agent:this.parent }}
}
/** Preset registration is observed; the CLI loader and its permission tree are outside this test. */
class PresetApiFixture extends Service {
  registered?:{ id:string;plugins:unknown[] }
  constructor(ctx:Context){super(ctx,'agentPresets')}
  composedPreset(){return undefined}
  composeFrom() {}
  async register(definition:{ id:string;plugins:unknown[] }){this.registered=definition;return ()=>{}}
}

describe('recorded CAD proposal through production Host services',()=>{
  it.each(recordings.flatMap(({ name,recording })=>[false,true].map(forced=>({ name,recording,forced }))))('replays $name with production ownership and denies forced global tools (forced=$forced)',async({ recording,forced })=>{
    const ctx=new Context();await mountAgentLoopTestDependencies(ctx);await mountLocalActivations(ctx);await ctx.plugin(AgentLoop,{ agents:[] });await ctx.plugin(SubagentRuntime);await ctx.plugin(Spawn,{ providerName:'spawn' });await ctx.plugin(JobsLocal)
    const sessions=new SessionApiFixture(ctx),presets=new PresetApiFixture(ctx)
    const forbidden=vi.fn(async()=>({ unexpected:true }))
    ctx.tools.register({ name:'fixture_filesystem_write',description:'Must never be offered to a design child',parameters:{ type:'object',properties:{} },output:{ schema:{ type:'object' },render:()=>[] },execute:forbidden })
    const adapter=new MockAdapter([...(forced?[toolCallResponse('forced-forbidden-call','fixture_filesystem_write',{})]:[]),toolCallResponse('recorded-cad-call',recording.call.name,recording.call.arguments)],{ efforts:[{ id:ReasoningEffortId('low'),name:'Low' }],defaultEffort:ReasoningEffortId('low') })
    ctx.llm.registerAdapter(['recorded'],adapter)
    let phase='awaiting_proposal';let submitted:Record<string,unknown>|undefined
    const fetch=vi.fn(async(input:string|URL,init?:RequestInit)=>{
      const pathname=new URL(input).pathname
      const body=init?.body?JSON.parse(String(init.body)):undefined
      if(pathname.endsWith('/driver'))return Response.json({ available:true })
      if(pathname.endsWith('/pending'))return Response.json(phase==='awaiting_proposal'?[{ id:'recorded-task',projectId:'recorded-project',workspacePath:process.cwd(),revision:1,phase }]:[])
      if(pathname.endsWith('/claim')){phase='claimed';return Response.json({ task:{ phase },proposal:{ token:'recorded-claim-token',attempt:1,prompt:recording.prompt } })}
      if(pathname.endsWith('/proposal')){submitted=body;phase='building';return Response.json({ phase })}
      return Response.json({ phase })
    })
    vi.stubGlobal('fetch',fetch)
    let child:Agent|undefined
    ctx.on('subagent/start',(info)=>{child=ctx.agents.get(info.id)})
    const host=await ctx.plugin(Host,{ optimizationEnabled:true,url:'http://127.0.0.1:4317',pollIntervalMs:250,requestTimeoutMs:1000,proposalTimeoutMs:10000,agentPreset:'castudio-optimization',proposalReasoningEffort:'low' })
    try{
      await vi.waitFor(()=>expect(submitted).toBeDefined(),{ timeout:10000 })
      await vi.waitFor(()=>expect(sessions.parent?.session.snapshotEvents().some(e=>e.type==='job/settled')).toBe(true))
      expect(submitted?.error).toBeUndefined()
      expect(submitted).toMatchObject({ attempt:1,token:'recorded-claim-token',sessionId:sessions.parent!.id,...recording.call.arguments })
      expect(submitted?.childId).toBe(child!.id)
      expect(presets.registered).toMatchObject({ id:'castudio-optimization',plugins:[] })
      expect(sessions.created).toMatchObject({ agentPreset:'castudio-optimization',cwd:process.cwd() })
      expect(adapter.requests).toHaveLength(forced?2:1)
      expect(child!.options.reasoningEffort).toBe('low')
      expect(adapter.requests[0]!.tools?.map(tool=>tool.name)).toEqual(['structured_output'])
      expect(adapter.requests[0]!.messages.some(message=>message.role==='user'&&message.content.some(block=>block.type==='text'&&block.text.includes(recording.prompt)))).toBe(true)
      expect(forbidden).not.toHaveBeenCalled()
      expect(child!.session.header.parentSession).toBe(sessions.parent!.id)
      const parentEvents=sessions.parent!.session.snapshotEvents()
      expect(parentEvents.filter(e=>['job/registered','subagent/catalog','job/settled'].includes(e.type)).map(e=>e.type)).toEqual(recording.expected.parentLifecycle)
      expect(parentEvents.filter(e=>e.type==='job/registered')).toHaveLength(1)
      expect(parentEvents.filter(e=>e.type==='subagent/catalog')).toHaveLength(1)
      const ended=parentEvents.find(e=>e.type==='job/settled')!
      expect(ended.type==='job/settled'&&ended.data).toMatchObject({ kind:recording.expected.jobKind,status:recording.expected.jobStatus })
      const calls=child!.session.snapshotEvents().filter(e=>e.type==='tool/call')
      expect(calls).toHaveLength(forced?2:1)
      expect(calls.at(-1)!.type==='tool/call'&&JSON.parse(calls.at(-1)!.data.arguments)).toEqual(recording.call.arguments)
      if(forced){const denied=child!.session.snapshotEvents().find(e=>e.type==='tool/result')!;expect(denied.type==='tool/result'&&denied.data.message.isError).toBe(true)}
      const result=child!.session.snapshotEvents().findLast(e=>e.type==='tool/result')!
      expect(result.type==='tool/result'&&result.data.message.content).toContainEqual({ type:'text',text:recording.expected.childToolResult })
      expect(child!.session.snapshotEvents().some(e=>e.type==='turn/end')).toBe(true)
    }finally{await host.dispose();vi.unstubAllGlobals()}
  },15000)
})
