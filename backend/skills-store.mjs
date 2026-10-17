import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { SKILL_ARCHIVE_LIMITS, safeSkillPath, archiveError } from './skill-archive.mjs';

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
  for (const key of ['modelInvocable', 'userInvocable']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid('技能调用方式无效');
  return { ...data, enabled: input.enabled, ...(input.modelInvocable === false ? { modelInvocable: false } : {}), ...(input.userInvocable === false ? { userInvocable: false } : {}) };
}

/** Parse without executing tags or accepting YAML aliases. */
export function parseSkillMarkdown(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 128 * 1024) throw invalid('SKILL.md 文件过大，最多 128 KB');
  const match = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw invalid('SKILL.md 需要以 YAML 开头，包含 name 和 description');
  const doc = parseDocument(match[1], { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length || doc.warnings.length) throw invalid('SKILL.md 的 YAML 格式无效');
  let meta;
  try { meta = doc.toJS({ maxAliasCount: 0 }); } catch { throw invalid('SKILL.md 不支持 YAML 引用'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw invalid('SKILL.md 的元信息无效');
  for (const key of ['disable-model-invocation', 'user-invocable']) if (meta[key] !== undefined && typeof meta[key] !== 'boolean') throw invalid('SKILL.md 中的调用限制必须是 true 或 false');
  return validate({ name: meta.name, title: meta.title || meta.metadata?.display_name || meta.name, description: meta.description, content: match[2], enabled: true,
    modelInvocable: meta['disable-model-invocation'] !== true, userInvocable: meta['user-invocable'] !== false });
}

function updatedSkillMarkdown(skill, original) {
  const frontmatter = original.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = frontmatter ? parseDocument(frontmatter[1]).toJS({ maxAliasCount: 0 }) : {};
  meta.name = skill.name; meta.description = skill.description;
  meta.metadata = { ...meta.metadata, display_name: skill.title };
  if ('title' in meta) meta.title = skill.title;
  if (skill.modelInvocable === false) meta['disable-model-invocation'] = true; else delete meta['disable-model-invocation'];
  if (skill.userInvocable === false) meta['user-invocable'] = false; else delete meta['user-invocable'];
  return `---\n${stringify(meta)}---\n\n${skill.content}\n`;
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
  const writeBytes = (file, bytes) => {
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
    finally { fs.rmSync(tmp, { force: true }); }
  };
  const list = uid => read(accountFile(uid)) || { revision: 0, skills: [] };
  const bundleDir = (uid, id) => {
    accountFile(uid);
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw missing();
    return path.join(root, 'bundles', hash(uid), id);
  };
  const find = (uid, id) => { const skill = list(uid).skills.find(item => item.id === id); if (!skill) throw missing(); return skill; };
  const manifest = (uid, id) => read(path.join(bundleDir(uid, id), 'manifest.json'));
  const packagePath = (uid, skill) => skill.package ? path.join(bundleDir(uid, skill.package.id), 'content', skill.package.root) : undefined;
  const cleanupBundle = (uid, id) => {
    if (!list(uid).skills.some(skill => skill.package?.id === id)) fs.rmSync(bundleDir(uid, id), { recursive: true, force: true });
  };
  const describeFiles = (uid, skill) => {
    if (!skill.package) return [];
    const base = skill.package.root ? skill.package.root + '/' : '';
    return (manifest(uid, skill.package.id)?.files || []).filter(file => file.path.startsWith(base))
      .map(file => ({ ...file, path: file.path.slice(base.length) }));
  };
  const resolveResource = (uid, skill, relative) => {
    const requested = safeSkillPath(relative);
    if (!describeFiles(uid, skill).some(file => file.path === requested)) throw missing();
    let target = root;
    const parts = ['bundles', hash(uid), skill.package.id, 'content', ...skill.package.root.split('/').filter(Boolean), ...requested.split('/')];
    try {
      for (const [index, part] of parts.entries()) {
        target = path.join(target, part);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw missing();
      }
      return { path: target, name: path.basename(target), size: fs.statSync(target).size };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw missing(); throw error; }
  };
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
    resourceBase(uid, skill) { return packagePath(uid, skill); },
    files(uid, id) { return describeFiles(uid, find(uid, id)); },
    file(uid, id, relative) {
      const skill = find(uid, id);
      return resolveResource(uid, skill, relative);
    },
    stageImport(uid, archive, filename) {
      const parent = path.join(root, 'bundles', hash(uid));
      accountFile(uid);
      let occupied = 0;
      const used = new Set(list(uid).skills.map(skill => skill.package?.id).filter(Boolean));
      if (fs.existsSync(parent)) for (const id of fs.readdirSync(parent)) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        const info = manifest(uid, id);
        if (!info) continue;
        if (!used.has(id) && Date.now() - info.createdAt > SKILL_ARCHIVE_LIMITS.ttl) fs.rmSync(bundleDir(uid, id), { recursive: true, force: true });
        else occupied += info.totalBytes;
      }
      if (occupied + archive.totalBytes > SKILL_ARCHIVE_LIMITS.account) throw archiveError('技能文件空间不足，请删除不再使用的技能后重试', 413);
      const id = randomUUID(), dir = bundleDir(uid, id);
      const existing = list(uid).skills;
      const files = archive.files.map(file => ({ path: file.path, size: file.bytes.length, executable: file.executable }));
      const skills = archive.skills.map(skill => {
        const prefix = skill.root ? skill.root + '/' : '';
        const ownFiles = files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) }));
        const previous = existing.find(item => item.name === skill.name);
        return { ...skill, files: ownFiles, ...(previous ? { existing: { id: previous.id, version: previous.version, title: previous.title } } : {}) };
      });
      try {
        for (const file of archive.files) {
          const target = path.join(dir, 'content', file.path);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, file.bytes, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' });
        }
        write(path.join(dir, 'manifest.json'), { createdAt: Date.now(), filename: String(filename).slice(0, 200), files, totalBytes: archive.totalBytes });
        write(path.join(dir, 'import.json'), { skills });
      } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
      return { id, filename, skills, fileCount: files.length, totalBytes: archive.totalBytes };
    },
    installImport(uid, id, replacements = {}) {
      const dir = bundleDir(uid, id), info = manifest(uid, id), staged = read(path.join(dir, 'import.json'));
      if (!info || !staged || Date.now() - info.createdAt > SKILL_ARCHIVE_LIMITS.ttl) throw Object.assign(new Error('导入预览已过期，请重新选择 ZIP 文件'), { status: 404 });
      const data = list(uid);
      const result = [], replaced = [];
      for (const draft of staged.skills) {
        const value = validate(draft);
        const previous = data.skills.find(skill => skill.name === value.name);
        if (previous && (replacements?.[value.name]?.id !== previous.id || replacements?.[value.name]?.version !== previous.version)) throw Object.assign(new Error(`「${previous.title}」已存在或已更新，请重新预览并确认替换`), { status: 409 });
        const now = new Date().toISOString();
        const skill = { ...value, id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now,
          package: { id, root: draft.root, fileCount: draft.files.length, totalBytes: draft.files.reduce((sum, file) => sum + file.size, 0) } };
        if (previous) { data.skills = data.skills.map(item => item.id === previous.id ? skill : item); if (previous.package) replaced.push(previous.package.id); }
        else data.skills.push(skill);
        result.push(skill);
      }
      if (data.skills.length > SKILL_LIMITS.count) throw invalid('最多可配置 50 个技能，请先删除不再使用的技能');
      persist(uid, data);
      fs.rmSync(path.join(dir, 'import.json'), { force: true });
      for (const old of new Set(replaced)) if (old !== id) cleanupBundle(uid, old);
      return result;
    },
    discardImport(uid, id) { if (!manifest(uid, id)) throw missing(); cleanupBundle(uid, id); },
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
      const skill = { ...value, id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now,
        ...(previous?.package ? { package: previous.package } : {}) };
      data.skills = previous ? data.skills.map(item => item.id === id ? skill : item) : [...data.skills, skill];
      if (previous?.package) {
        const main = resolveResource(uid, previous, 'SKILL.md').path;
        const original = fs.readFileSync(main, 'utf8');
        const changed = updatedSkillMarkdown(skill, original);
        const manifestFile = path.join(bundleDir(uid, previous.package.id), 'manifest.json');
        const before = read(manifestFile), after = structuredClone(before);
        const key = previous.package.root ? previous.package.root + '/SKILL.md' : 'SKILL.md';
        const row = after.files.find(file => file.path === key);
        const delta = Buffer.byteLength(changed) - row.size;
        row.size += delta; after.totalBytes += delta;
        skill.package = { ...previous.package, totalBytes: previous.package.totalBytes + delta };
        try { writeBytes(main, changed); write(manifestFile, after); persist(uid, data); }
        catch (error) { writeBytes(main, original); write(manifestFile, before); throw error; }
      } else persist(uid, data);
      return skill;
    },
    remove(uid, id, version) {
      const data = list(uid);
      const previous = data.skills.find(item => item.id === id);
      if (!previous) throw missing();
      assertVersion(previous, version);
      data.skills = data.skills.filter(item => item.id !== id);
      persist(uid, data);
      if (previous.package) cleanupBundle(uid, previous.package.id);
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
