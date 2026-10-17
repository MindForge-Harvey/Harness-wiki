import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSkillChanges } from '../src/lib/skills-draft.mjs';

const blank = { title: '', name: '', description: '', content: '', enabled: true };
test('empty and cleared new skills can close without a discard prompt', () => {
  assert.equal(hasSkillChanges(null, 'null'), false);
  assert.equal(hasSkillChanges(blank, 'null'), false);
  assert.equal(hasSkillChanges({ ...blank, title: '  ', content: '\n', enabled: false }, 'null'), false);
});
test('new content, templates and imported skills require a discard decision', () => {
  for (const key of ['title', 'name', 'description', 'content']) assert.equal(hasSkillChanges({ ...blank, [key]: 'content' }, 'null'), true);
});
test('saved skills can close unchanged, including after reverting edits', () => {
  const saved = { ...blank, id: 'saved', title: '技能', enabled: true };
  const baseline = JSON.stringify(saved);
  assert.equal(hasSkillChanges(saved, baseline), false);
  assert.equal(hasSkillChanges({ ...saved, title: '修改' }, baseline), true);
  assert.equal(hasSkillChanges({ ...saved, enabled: false }, baseline), true);
  assert.equal(hasSkillChanges({ ...saved, title: saved.title }, baseline), false);
});
