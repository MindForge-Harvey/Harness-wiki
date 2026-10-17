import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const missing = () => Object.assign(new Error('技能不存在'), { status: 404 });
const hash = value => createHash('sha256').update(value).digest('hex');
export const SKILL_LIMITS = { count: 50, title: 60, name: 64, description: 1000, content: 32000, totalBytes: 512 * 1024 };

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('技能配置必须是对象');
  const data = {};
  for (const key of ['title', 'name', 'description', 'content']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw invalid({ title: '请填写技能名称', name: '请填写调用名称', description: '请填写何时使用', content: '请填写技能指令' }[key]);
    data[key] = input[key].trim();
    if (data[key].length > SKILL_LIMITS[key]) throw invalid(`${{ title: '技能名称', name: '调用名称', description: '触发说明', content: '技能指令' }[key]}超过长度限制`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)) throw invalid('调用名称仅支持小写英文、数字和连字符，例如 answer-format');
  if (typeof input.enabled !== 'boolean') throw invalid('启用状态无效');
  return { ...data, enabled: input.enabled };
}

/** Parse without executing tags or accepting YAML aliases. Imports are single-file instructions. */
export function parseSkillMarkdown(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 128 * 1024) throw invalid('SKILL.md 文件过大，最多 128 KB');
  const match = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw invalid('SKILL.md 需要以 YAML 开头，包含 name 和 description');
  const doc = parseDocument(match[1], { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length || doc.warnings.length) throw invalid('SKILL.md 的 YAML 格式无效');
  let meta;
  try { meta = doc.toJS({ maxAliasCount: 0 }); } catch { throw invalid('SKILL.md 不支持 YAML 引用'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw invalid('SKILL.md 的元信息无效');
  if (meta['disable-model-invocation'] === true || meta['user-invocable'] === false) throw invalid('当前仅支持可自动调用、可手动调用的技能，请移除调用限制后再导入');
  return validate({ name: meta.name, title: meta.title || meta.metadata?.display_name || meta.name, description: meta.description, content: match[2], enabled: true });
}

/** Atomic, account-scoped configuration on the existing persistent storages volume. */
export function createSkillsStore(root) {
  if (!root) throw new Error('Missing skills storage directory');
  const accountFile = uid => {
    if (typeof uid !== 'string' || !uid) throw new Error('Missing authenticated user ID');
    return path.join(root, 'accounts', hash(uid) + '.json');
  };
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  };
  const list = uid => read(accountFile(uid)) || { revision: 0, skills: [] };
  const persist = (uid, data) => {
    data.revision += 1;
    if (Buffer.byteLength(JSON.stringify(data)) > SKILL_LIMITS.totalBytes) throw invalid('技能总容量已达上限，请精简指令后重试');
    write(accountFile(uid), data);
  };
  const assertVersion = (record, version) => {
    if (version !== record.version) throw Object.assign(new Error('该技能已在其他窗口修改，请重新加载后编辑'), { status: 409 });
  };
  return {
    list,
    seed(uid, inputs, bundle) {
      if (typeof bundle !== 'string' || !bundle) throw new Error('Missing starter skills bundle ID');
      const data = list(uid);
      if (data.seededBundles?.includes(bundle)) return data;
      const defaults = inputs.map(validate);
      const names = new Set(data.skills.map(skill => skill.name));
      const now = new Date().toISOString();
      data.seededBundles = [...(data.seededBundles || []), bundle];
      for (const value of defaults) {
        if (names.has(value.name) || data.skills.length >= SKILL_LIMITS.count) continue;
        const skill = { ...value, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
        if (Buffer.byteLength(JSON.stringify({ ...data, skills: [...data.skills, skill] })) > SKILL_LIMITS.totalBytes - 64) continue;
        data.skills.push(skill);
        names.add(value.name);
      }
      persist(uid, data);
      return data;
    },
    save(uid, input, id) {
      const value = validate(input);
      const data = list(uid);
      const previous = id ? data.skills.find(item => item.id === id) : null;
      if (id && !previous) throw missing();
      if (previous) assertVersion(previous, input.version);
      if (!previous && data.skills.length >= SKILL_LIMITS.count) throw invalid('最多可配置 50 个技能');
      if (data.skills.some(item => item.name === value.name && item.id !== id)) throw invalid('调用名称已被使用，请换一个名称');
      const now = new Date().toISOString();
      const skill = { ...value, id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now };
      data.skills = previous ? data.skills.map(item => item.id === id ? skill : item) : [...data.skills, skill];
      persist(uid, data);
      return skill;
    },
    remove(uid, id, version) {
      const data = list(uid);
      const previous = data.skills.find(item => item.id === id);
      if (!previous) throw missing();
      assertVersion(previous, version);
      data.skills = data.skills.filter(item => item.id !== id);
      persist(uid, data);
    },
    bindSession(uid, sessionId) {
      accountFile(uid);
      const file = path.join(root, 'sessions', hash(sessionId) + '.json');
      const binding = read(file);
      if (binding && binding.uid !== uid) throw new Error('Skill session ownership mismatch');
      if (!binding) write(file, { uid });
    },
    owner(sessionId) { return read(path.join(root, 'sessions', hash(sessionId) + '.json'))?.uid; },
  };
}
