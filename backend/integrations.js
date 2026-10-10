import fs from 'node:fs'
import path from 'node:path'

function writeRuntimeConfig(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return
  fs.writeFileSync(file, content)
}

export function textReasoningEffort(env = process.env) {
  return env.LLM_REASONING_EFFORT || (/^qwen/i.test(env.LLM_MODEL || 'qwen3.8-flash') ? 'off' : undefined)
}

export function prepareHarnessHome(home, backendDir, { profile = process.env.DSH_PROFILE || 'rag-kb', env = process.env } = {}) {
  const templateProfiles = path.join(backendDir, 'dsh/home/profiles')
  const profileDir = path.join(templateProfiles, profile)
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  fs.mkdirSync(home, { recursive: true })
  if (!fs.existsSync(path.join(home, 'profiles'))) {
    fs.symlinkSync(templateProfiles, path.join(home, 'profiles'), 'dir')
  }
  const modules = path.join(profileDir, 'node_modules')
  fs.mkdirSync(modules, { recursive: true })
  for (const [name, target] of Object.entries(manifest.dependencies || {})) {
    if (!target.startsWith('link:')) continue
    const link = path.join(modules, name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(profileDir, target.slice(5)), link, 'dir')
  }

  const provider = env.LLM_PROVIDER || 'aliyun'
  const model = env.LLM_MODEL || 'qwen3.8-flash'
  const visionModel = env.VLM_MODEL || 'qwen3.8-omni-flash'
  const qwen = /^qwen/i.test(model)
  // The Qwen adapter sends enable_thinking:false only when model.reasoning is true
  // and the selected effort is off. reasoningEfforts:false alone does not disable it.
  const modelConfig = (id, input) => ({ id, name: id, input, contextWindow: 1000000, maxTokens: 65536, reasoningEfforts: false })
  const settings = {
    'ui-theme': { preference: 'light' },
    'agent-presets': { default: 'cordis' },
    'agent-default-model': { provider, model },
    'llm-pi-ai': { providers: {
      [provider]: {
        baseURL: env.LLM_BASE_URL,
        api: 'openai-completions',
        apiKeyEnv: 'LLM_API_KEY',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false,
          ...(qwen ? { thinkingFormat: 'qwen' } : {}) },
        ...(textReasoningEffort(env) ? { reasoning: textReasoningEffort(env) } : {}),
        models: [{ ...modelConfig(model, ['text']),
          ...(qwen ? { reasoningEfforts: { off: null, medium: 'medium' } } : {}) }],
      },
      'aliyun-vision': {
        baseURL: env.VLM_BASE_URL || env.LLM_BASE_URL,
        api: 'openai-completions',
        apiKeyEnv: 'VLM_API_KEY',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [modelConfig(visionModel, ['text', 'image'])],
      },
    } },
  }
  // JSON is valid YAML. Only credential variable names, never key values, enter settings.
  writeRuntimeConfig(path.join(home, 'settings.yaml'), JSON.stringify(settings, null, 2) + '\n')
  const patch = path.join(home, 'runtime.cordis.patch.json')
  const rows = profile === 'rag-kb'
    ? [{ id: 'webserver', config: { host: '127.0.0.1', port: Number(env.DSH_CHILD_HTTP_PORT) || 3090 } }]
    : []
  writeRuntimeConfig(patch, JSON.stringify(rows))
  return patch
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + String(data.error?.message || data.detail || response.statusText).slice(0, 300))
  return data
}

export async function integrationHealth() {
  const check = async (base, suffix, headers) => {
    if (!base) return { ok: false, error: '未配置服务地址' }
    try {
      const data = await fetchJson(base.replace(/\/+$/, '') + suffix, { headers })
      return { ok: true, url: base, status: data.status, version: data.core_version || data.version, pipeline_busy: data.pipeline_busy, parser_routing: data.configuration?.parser_routing }
    }
    catch (error) { return { ok: false, url: base, error: error.message } }
  }
  const [lightrag, mineru] = await Promise.all([
    check(process.env.LIGHTRAG_BASE_URL, '/health', { 'X-API-Key': process.env.LIGHTRAG_API_KEY || '' }),
    check(process.env.MINERU_BASE_URL, '/v1/health', { Authorization: 'Bearer ' + (process.env.MINERU_API_KEY || '') }),
  ])
  return {
    ok: lightrag.ok && mineru.ok,
    lightrag, mineru,
    models: { text: process.env.LLM_MODEL, multimodal: process.env.VLM_MODEL },
    filesystem_features: { graphml_analysis: !!process.env.KB_RAG_STORAGE, source_images: !!process.env.KB_LIGHTRAG_INPUTS_DIR },
  }
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export async function analyzeImageAttachments(files, question) {
  const images = files.filter((file) => IMAGE_TYPES[path.extname(file).toLowerCase()])
  if (!images.length) return ''
  const key = process.env.VLM_API_KEY || process.env.LLM_API_KEY
  const base = process.env.VLM_BASE_URL || process.env.LLM_BASE_URL
  if (!key || !base) throw new Error('图片分析需要配置 VLM_BASE_URL 和 VLM_API_KEY')
  const content = [{ type: 'text', text: '请根据用户问题分析上传图片，说明图片中可见的文字、图表和事实，不要猜测。用户问题：' + question }]
  for (const file of images) {
    const bytes = fs.readFileSync(file)
    if (bytes.length > (Number(process.env.VLM_MAX_IMAGE_BYTES) || 5 * 1024 * 1024)) throw new Error('图片超过多模态模型输入限制：' + path.basename(file))
    content.push({ type: 'image_url', image_url: { url: 'data:' + IMAGE_TYPES[path.extname(file).toLowerCase()] + ';base64,' + bytes.toString('base64') } })
  }
  const data = await fetchJson(base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.VLM_MODEL || 'qwen3.8-omni-flash', messages: [{ role: 'user', content }], max_tokens: 2048, enable_thinking: false }),
  }, 120000)
  const answer = data.choices?.[0]?.message?.content
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('多模态模型未返回图片分析内容')
  return '\n\n视觉模块已直接读取用户上传图片并完成分析，以下为图片事实（来自上传文件，不是知识库证据）。请基于这些事实直接回答图片问题；本系统的图片识别已完成，无需用户切换模型。\n' + answer
}
