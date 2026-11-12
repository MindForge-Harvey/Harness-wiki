import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export function skillDirectories(root) {
  return ['skills', '.agents/skills', '.dsh/skills'].map(directory => path.resolve(root, directory))
}

/** 与执行端共用 SDK 目录解析；不启动模型，不维护第二份能力清单。 */
export async function listProjectSkills(root) {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  let provider
  const unregister = registry.registerProvider(control => {
    provider = new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, customSkillDirs: skillDirectories(root), watch: false,
    })
    return provider
  })
  try { return (await registry.snapshot({ cwd: root })).skills }
  finally {
    try { await provider?.dispose() }
    finally { unregister(); await ctx.fiber.dispose() }
  }
}

export async function validateSelectedSkills(root, names) {
  if (names === undefined) return []
  if (!Array.isArray(names) || names.length > 30 || names.some(name => typeof name !== 'string')) {
    throw Object.assign(new Error('所选 Skills 必须是名称数组'), { status: 400 })
  }
  const unique = [...new Set(names)]
  if (!unique.length) return []
  const available = new Set((await listProjectSkills(root)).map(skill => skill.name))
  if (unique.some(name => !available.has(name))) throw Object.assign(new Error('所选 Skill 不在当前 Skills 库中'), { status: 400 })
  return unique
}
