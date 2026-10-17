import { createSkillsStore } from '../../../skills-store.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { scopeChainOf } from '@deepseek-ai/dsh-scope';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';

function loadedSkillNames(session) {
  const names = new Set();
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/call' && event.data.name === 'skill') {
      try { names.add(JSON.parse(event.data.arguments).name); } catch { /* Ignore malformed historical calls. */ }
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-invocation') names.add(event.data.source.name);
  }
  return names;
}

export function personalSkillProvider(store, uid) {
  const invocation = { modelInvocable: true, userInvocable: true };
  const definition = skill => ({ name: skill.name, description: skill.description, content: skill.content,
    source: 'personal', provider: 'personal-skills', invocation,
    resourceBase: { kind: 'opaque', description: '在 Skills 配置中保存的单文件技能；未提供额外脚本或附件。' } });
  return {
    name: 'personal-skills',
    async list() {
      return store.list(uid).skills.filter(skill => skill.enabled).map(skill => ({ ...definition(skill), rank: 100, locator: skill.id }));
    },
    async get(candidate) {
      const skill = store.list(uid).skills.find(item => item.id === candidate.locator && item.enabled && item.name === candidate.name);
      return skill ? definition(skill) : undefined;
    },
  };
}

/** Keep private catalogs inside each agent's scope; refresh before the native skill catalog is assembled. */
export function mountPersonalSkills(ctx) {
  if (!process.env.HARNESS_SKILLS_DIR) return;
  const store = createSkillsStore(process.env.HARNESS_SKILLS_DIR);
  const states = new WeakMap();
  ctx.on('agent/created', async ({ agent }) => {
    const uid = store.owner(agent.session.id) || scopeChainOf(agent).map(key => states.get(key)?.uid).find(Boolean);
    if (!uid) return; // Only a bound session or an agent inside its scope may receive private skills.
    let control;
    await agent.ctx.inject(['skills'], scope => {
      scope.skills.registerProvider(value => { control = value; return personalSkillProvider(store, uid); });
    });
    states.set(agent, { uid, config: store.list(uid), control });
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const state = states.get(agent);
    let changed;
    if (state) {
      const config = store.list(state.uid);
      if (config.revision !== state.config.revision) { changed = config; state.control.invalidate(); }
    }
    const decision = await next();
    if (!changed || decision.kind === 'reject') return decision;
    const previousVersions = new Map(state.config.skills.map(skill => [skill.id, skill.version]));
    const loaded = loadedSkillNames(agent.session);
    const refreshed = changed.skills.filter(skill => skill.enabled && loaded.has(skill.name) && previousVersions.get(skill.id) !== skill.version);
    state.config = changed;
    const active = changed.skills.filter(skill => skill.enabled).map(skill => skill.name);
    const message = createUserMessage({ source: { kind: 'personal-skill-config', revision: changed.revision }, content: [{ type: 'text', text:
      `用户已更新个人 Skills 配置，此配置替换此前的个人技能配置。当前启用的个人技能：${active.join('、') || '无'}。未列出的个人技能已停用或删除，请勿继续沿用旧指令。已经使用过且本次修改的技能，其最新完整指令附在此提醒之后，替换此前同名技能内容。只在任务适用时遵循技能；尚未加载过的技能仍通过 skill 工具按需加载。直接完成用户任务，不要只回复准备加载技能。` }] });
    const updates = refreshed.map(skill => createUserMessage({ source: { kind: 'personal-skill-refresh', name: skill.name, version: skill.version }, content: [{ type: 'text', text: renderSkillContent({ name: skill.name, provider: 'personal-skills', content: skill.content, resourceBase: { kind: 'opaque', description: '用户在 Skills 配置中保存的单文件指令。' } }) }] }));
    return { ...decision, messages: [...decision.messages, message, ...updates] };
  });
}
