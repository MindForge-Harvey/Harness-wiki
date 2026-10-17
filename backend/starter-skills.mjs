import fs from 'node:fs';
import { parseSkillMarkdown } from './skills-store.mjs';

export const STARTER_SKILLS_BUNDLE = 'knowledge-assistant-starters-v1';
export function loadStarterSkills() {
  return ['grill-me', 'knowledge-qa', 'meeting-notes', 'document-compare'].map(name => {
    const skill = parseSkillMarkdown(fs.readFileSync(new URL(`./starter-skills/${name}/SKILL.md`, import.meta.url), 'utf8'));
    if (skill.name !== name) throw new Error(`Starter skill name mismatch: ${name}`);
    return skill;
  });
}
