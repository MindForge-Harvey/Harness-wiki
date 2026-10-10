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
