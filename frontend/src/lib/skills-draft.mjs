/** An untouched or cleared new form has nothing to lose; templates and imports do. */
export function hasSkillChanges(draft, baseline) {
  if (!draft) return false;
  if (!draft.id) return ['title', 'name', 'description', 'content'].some(key => draft[key]?.trim());
  return JSON.stringify(draft) !== baseline;
}
