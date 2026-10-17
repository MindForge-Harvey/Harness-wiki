import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

export const SKILL_ARCHIVE_LIMITS = { compressed: 20 * 1024 * 1024, expanded: 100 * 1024 * 1024, file: 20 * 1024 * 1024, entries: 1000, account: 500 * 1024 * 1024, ttl: 60 * 60 * 1000 };
export const archiveError = (message, status = 400) => Object.assign(new Error(message), { status });
export function safeSkillPath(name) {
  if (typeof name !== 'string' || !name || name.length > 500 || /[\\\x00-\x1f\x7f]/.test(name) || /^[a-z]:/i.test(name) || name.startsWith('/')) throw archiveError('技能包包含无效的文件路径');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw archiveError('技能包包含越界的文件路径');
  return parts.join('/');
}

/** Sequential, bounded decompression; nothing from an archive is executed during import. */
export async function parseSkillArchive(bytes, parseMarkdown) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw archiveError('请选择非空的 ZIP 技能包');
  if (bytes.length > SKILL_ARCHIVE_LIMITS.compressed) throw archiveError('ZIP 技能包最多 20 MB', 413);
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(archiveError('ZIP 文件无效或已损坏')) : resolve(value)));
  const files = [];
  let total = 0, entries = 0;
  const names = new Set();
  await new Promise((resolve, reject) => {
    let stopped = false;
    const fail = error => { if (stopped) return; stopped = true; zip.close(); reject(error.status ? error : archiveError('ZIP 文件无效或已损坏')); };
    zip.on('error', fail);
    zip.on('end', () => { if (!stopped) { stopped = true; resolve(); } });
    zip.on('entry', entry => {
      void (async () => {
        if (++entries > SKILL_ARCHIVE_LIMITS.entries) throw archiveError('技能包包含过多文件，最多 1000 项');
        const name = safeSkillPath(entry.fileName);
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & 0o170000;
        if (type && type !== 0o100000 && type !== 0o040000) throw archiveError('技能包不能包含符号链接或特殊文件');
        if (entry.generalPurposeBitFlag & 1) throw archiveError('请先解密 ZIP 文件，再导入技能包');
        const folded = name.normalize('NFC').toLocaleLowerCase();
        if (names.has(folded)) throw archiveError('技能包包含重复或大小写冲突的文件路径');
        names.add(folded);
        if (entry.fileName.endsWith('/') || name.split('/').includes('__MACOSX') || path.posix.basename(name) === '.DS_Store') { zip.readEntry(); return; }
        if (entry.uncompressedSize > SKILL_ARCHIVE_LIMITS.file || total + entry.uncompressedSize > SKILL_ARCHIVE_LIMITS.expanded) throw archiveError('技能包解压后过大：单文件最多 20 MB，合计最多 100 MB', 413);
        const stream = await new Promise((ok, bad) => zip.openReadStream(entry, (error, value) => error ? bad(error) : ok(value)));
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > SKILL_ARCHIVE_LIMITS.file || total + size > SKILL_ARCHIVE_LIMITS.expanded) { stream.destroy(); throw archiveError('技能包解压后超过大小限制', 413); }
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks);
        if (size !== entry.uncompressedSize || crc32(content) !== entry.crc32) throw archiveError(`文件已损坏：${name}`);
        total += size;
        files.push({ path: name, bytes: content, executable: !!(mode & 0o111) });
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  const filePaths = new Set(files.map(file => file.path.normalize('NFC').toLocaleLowerCase()));
  for (const file of files) {
    const parts = file.path.normalize('NFC').toLocaleLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (filePaths.has(parts.slice(0, i).join('/'))) throw archiveError('技能包的文件与目录路径冲突');
  }
  const roots = files.filter(file => path.posix.basename(file.path) === 'SKILL.md')
    .map(file => ({ file, root: path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path) }))
    .sort((a, b) => (a.root ? a.root.split('/').length : 0) - (b.root ? b.root.split('/').length : 0));
  const selected = [];
  for (const item of roots) if (!selected.some(parent => !parent.root || item.root.startsWith(parent.root + '/'))) selected.push(item);
  if (!selected.length) throw archiveError('ZIP 中没有找到 SKILL.md，请保留技能的目录结构');
  if (selected.length > 50) throw archiveError('一个技能包最多包含 50 个技能');
  const skillNames = new Set();
  const skills = selected.map(({ file, root }) => {
    let skill;
    try { skill = parseMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); }
    catch (error) { throw error.status ? error : archiveError(`${file.path} 必须是有效的 UTF-8 文本`); }
    if (skillNames.has(skill.name)) throw archiveError(`技能包包含重复的调用名称：${skill.name}`);
    skillNames.add(skill.name);
    return { ...skill, root };
  });
  return { files, skills, totalBytes: total };
}
