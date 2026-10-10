/** 真实 SDK 目录、工具、沙箱与 profile 启动验证；模型和知识服务均用本地替身。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyToolSkill } from '@deepseek-ai/dsh-tool-skill'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { skillDirectories, listProjectSkills } from '../harness/skills.mjs'
import { prepareHarnessHome, textReasoningEffort } from '../integrations.js'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(backendDir, '..')
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const markdown = (name, body) => `---\nname: ${name}\ndescription: Local fixture\n---\n${body}\n`

function temporary(t) {
  const runs = path.join(workspaceRoot, '.run')
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, 'harness-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, relative, content) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('SDK discovers project roots with stable precedence and excludes user-home skills', async t => {
  const root = temporary(t)
  write(root, 'skills/shared/SKILL.md', markdown('shared', 'Project implementation.'))
  write(root, '.agents/skills/shared/SKILL.md', markdown('shared', 'Secondary implementation.'))
  write(root, '.dsh/skills/extra/SKILL.md', markdown('extra', 'Extra skill.'))
  write(root, 'user-home/skills/personal/SKILL.md', markdown('personal', 'Personal skill.'))
  write(root, 'skills/invalid/SKILL.md', 'Missing frontmatter.\n')
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  let provider
  const unregister = registry.registerProvider(control => {
    provider = new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, customSkillDirs: skillDirectories(root),
      dshHome: path.join(root, 'user-home'), agentsHome: path.join(root, 'user-home'), watch: false,
    })
    return provider
  })
  t.after(async () => { await provider.dispose(); unregister(); await ctx.fiber.dispose() })
  assert.deepEqual((await listProjectSkills(root)).map(skill => skill.name).sort(), ['extra', 'shared'])
  assert.deepEqual((await registry.list({ cwd: root })).map(skill => skill.name).sort(), ['extra', 'shared'])
  assert.equal((await registry.get('shared', { cwd: root })).content, 'Project implementation.')
})

test('real skill tool loads the shipped ECHO-Mem workflow and its resource directory', async t => {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  let provider
  const unregister = registry.registerProvider(control => {
    provider = new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, customSkillDirs: skillDirectories(workspaceRoot), watch: false,
    })
    return provider
  })
  t.after(async () => { await provider.dispose(); unregister(); await ctx.fiber.dispose() })
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  applyToolSkill(ctx)
  const result = await ctx.tools.get('skill').execute({ name: 'wireless-echo-mem' }, {
    signal: new AbortController().signal,
  })
  const directory = path.join(workspaceRoot, 'skills/wireless-echo-mem')
  const loaded = await registry.get('wireless-echo-mem', { cwd: workspaceRoot })
  assert.equal(result.content, loaded.content)
  assert.deepEqual(result.resourceBase, { kind: 'directory', path: directory })
  assert.ok(result.content.length > 0)
})

test('home preparation links manifest plugins and preserves unchanged watched configuration', t => {
  const root = temporary(t)
  const profile = 'fixture'
  const profileDir = path.join(root, 'dsh/home/profiles', profile)
  write(root, 'dsh/local-helper/package.json', '{}')
  write(root, `dsh/home/profiles/${profile}/package.json`, JSON.stringify({
    dependencies: { '@local/helper': 'link:../../../local-helper' },
  }))
  const home = path.join(root, 'home')
  const env = { LLM_PROVIDER: 'fixture', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'do-not-persist' }
  const patch = prepareHarnessHome(home, root, { profile, env })
  assert.equal(fs.realpathSync(path.join(profileDir, 'node_modules/@local/helper')), path.join(root, 'dsh/local-helper'))
  assert.deepEqual(JSON.parse(fs.readFileSync(patch, 'utf8')), [])
  const files = [patch, path.join(home, 'settings.yaml')]
  for (const file of files) fs.utimesSync(file, 100, 100)
  prepareHarnessHome(home, root, { profile, env })
  for (const file of files) {
    assert.equal(fs.statSync(file).mtimeMs, 100000)
    assert.ok(!fs.readFileSync(file, 'utf8').includes(env.LLM_API_KEY))
  }
})

test('real workspace-write shell allows task output and denies a sibling file', {
  skip: process.platform !== 'darwin' ? '本用例验证 macOS Seatbelt；其他部署需运行其平台沙箱验证。' : false,
}, async t => {
  const root = temporary(t)
  const work = path.join(root, 'workspace')
  fs.mkdirSync(work)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: work })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxBashExecutor, { cwd: work, timeoutMs: 10000, maxTimeoutMs: 10000 })
  const run = file => ctx.shell.run(ctx.shell.resolve({
    command: `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(file)}, 'fixture')`)}`,
    env: { PATH: process.env.PATH },
  }))
  const inside = path.join(work, 'result.txt')
  const allowed = await run(inside)
  assert.equal(allowed.exitCode, 0, allowed.stderr.text)
  assert.equal(allowed.sandbox.enforcement, 'full')
  assert.equal(allowed.sandbox.mode, 'workspace-write')
  assert.equal(fs.readFileSync(inside, 'utf8'), 'fixture')
  const outside = path.join(root, 'outside.txt')
  const denied = await run(outside)
  assert.notEqual(denied.exitCode, 0)
  assert.equal(denied.sandbox.enforcement, 'full')
  assert.equal(denied.sandbox.mode, 'workspace-write')
  assert.equal(fs.existsSync(outside), false)
})

test('production rag-kb profile starts and closes without model requests or real knowledge services', { timeout: 25000 }, async t => {
  const root = temporary(t)
  let modelCalls = 0
  const fixture = createServer((req, res) => {
    if (req.url.includes('/chat/completions')) modelCalls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ statuses: {}, documents: [], status: 'ok' }))
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  // Reserve a separate child HTTP port without touching the existing application.
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const baseURL = `http://127.0.0.1:${fixture.address().port}`
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, {
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_CHILD_HTTP_PORT: String(port),
    LLM_PROVIDER: 'fixture', LLM_BASE_URL: baseURL + '/v1', LLM_API_KEY: 'local-fixture',
    LIGHTRAG_BASE_URL: baseURL, LIGHTRAG_API_KEY: 'local-fixture',
    // Exercise legacy/direct startup too: the profile resolves project roots without this variable.
    // The deployment profile must retain workspace-write + ask even under inherited overrides.
    DSH_PERMISSION_MODE: 'danger-full-access',
  })
  const home = path.join(root, 'home')
  const patch = prepareHarnessHome(home, backendDir, { profile: 'rag-kb', env })
  const profile = loadProfileDirectory('contract', path.join(backendDir, 'dsh/home/profiles/rag-kb'),
    path.join(backendDir, 'node_modules/@deepseek-ai/dsh-sdk-client/package.json'))
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const findEntry = (value, id) => {
    if (!value || typeof value !== 'object') return undefined
    if (value.id === id) return value
    for (const child of Object.values(value)) {
      const entry = findEntry(child, id)
      if (entry) return entry
    }
  }
  assert.equal(findEntry(entries, 'sandbox-policy').config.mode, 'workspace-write')
  assert.equal(findEntry(entries, 'approval').config.policy, 'ask')
  assert.equal(findEntry(entries, 'skill-filesystem').config.includeDefaultRoots, false)
  assert.equal(findEntry(entries, 'bash-sandbox').config.maxTimeoutMs, 300000)
  const harness = new DeepSeekHarness({
    profile: 'rag-kb', cwd: workspaceRoot, processCwd: workspaceRoot, dshHome: home,
    patches: [patch], env, provider: 'fixture', model: 'qwen3.8-flash',
    initializeTimeoutMs: 15000, shutdownTimeoutMs: 1000, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
  })
  t.after(async () => {
    try { await harness.close() }
    finally {
      fixture.closeAllConnections()
      await new Promise(resolve => fixture.close(resolve))
    }
    assert.equal(modelCalls, 0)
  })
  await harness.start()
  const response = await fetch(`http://127.0.0.1:${port}/approvals/pending`, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
})

test('real SDK Qwen dispatch sends enable_thinking:false rather than hiding provider-default reasoning', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(workspaceRoot, '.run/harness-contract-'))
  const requests = []
  const fixture = createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks)))
      const event = (delta, finish_reason) => ({
        id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1,
        model: 'qwen3.8-flash', choices: [{ index: 0, delta, finish_reason }],
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify(event({ role: 'assistant', content: '已关闭推理。' }, null)) + '\n\n'
        + 'data: ' + JSON.stringify(event({}, 'stop')) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const childPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, {
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_CHILD_HTTP_PORT: String(childPort),
    LLM_PROVIDER: 'fixture', LLM_MODEL: 'qwen3.8-flash',
    LLM_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`,
    LLM_API_KEY: 'local-fixture', LLM_REASONING_EFFORT: 'off',
  })
  const home = path.join(root, 'home')
  const patch = prepareHarnessHome(home, backendDir, { profile: 'rag-kb', env })
  const harness = new DeepSeekHarness({
    profile: 'rag-kb', cwd: workspaceRoot, processCwd: workspaceRoot,
    dshHome: home, patches: [patch], env, provider: 'fixture', model: env.LLM_MODEL,
    reasoningEffort: textReasoningEffort(env), initializeTimeoutMs: 15000, shutdownTimeoutMs: 1000,
    disposeEofGraceMs: 1000, disposeGraceMs: 1000,
  })
  t.after(async () => {
    try { await harness.close() } finally {
      fixture.closeAllConnections()
      await new Promise(resolve => fixture.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  await harness.start()
  const session = harness.session('thinking-disabled-contract')
  const result = await session.run('你好')
  assert.equal(result.finalResponse, '已关闭推理。')
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.enable_thinking === false), JSON.stringify(requests.map(request => ({ model: request.model, enable_thinking: request.enable_thinking }))))
  assert.ok(requests.every(request => !('reasoning_effort' in request)))
  assert.equal(textReasoningEffort({ LLM_MODEL: 'qwen3.8-flash' }), 'off')
})
