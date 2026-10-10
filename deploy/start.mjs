import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Credentials remain in the server-managed environment, never in settings.
const provider = process.env.LLM_PROVIDER || 'aliyun';
const model = process.env.LLM_MODEL || 'qwen3.8-flash';
if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) throw new Error('LLM_BASE_URL and LLM_API_KEY are required');
writeFileSync('/app/backend/dsh/home/settings.yaml', JSON.stringify({
  'ui-theme': { preference: 'light' },
  'agent-presets': { default: 'cordis' },
  'agent-default-model': { provider, model },
  'llm-pi-ai': { providers: { [provider]: {
    baseURL: process.env.LLM_BASE_URL,
    api: 'openai-completions', apiKeyEnv: 'LLM_API_KEY',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: 'qwen' },
    reasoning: 'off',
    // Qwen exposes thinking on/off; the route defaults to off. The SDK requires
    // at least one enabled level when describing a thinking-capable model.
    models: [{ id: model, name: model, input: ['text'], contextWindow: 1000000, maxTokens: 65536, reasoningEfforts: { off: null, high: 'high' } }],
  } } },
}, null, 2));

const children = [
  spawn(process.execPath, ['index.js'], { cwd: '/app/backend', stdio: 'inherit' }),
  spawn('nginx', ['-g', 'daemon off;'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  children.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const timer = setTimeout(() => { children.forEach(child => child.kill('SIGKILL')); process.exit(code); }, 15000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => { clearTimeout(timer); process.exit(code); });
}
children.forEach(child => {
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code || 1));
});
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
