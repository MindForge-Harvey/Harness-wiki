import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbSourceStore } from '../kb-sources.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kb-source-'));

test('knowledge source resolves exact names and category-prefixed files only', () => {
  const dir = temp();
  const outside = path.join(path.dirname(dir), 'outside.docx');
  try {
    fs.writeFileSync(path.join(dir, '员工休假管理办法.docx'), 'exact');
    fs.writeFileSync(path.join(dir, '人力资源管理_员工管理_差旅管理办法.docx'), 'prefixed');
    fs.mkdirSync(path.join(dir, '__parsed__'));
    fs.writeFileSync(path.join(dir, '__parsed__', '报销制度.xlsx'), 'parsed-exact');
    fs.writeFileSync(path.join(dir, '说明.txt'), 'text');
    fs.writeFileSync(path.join(dir, '脚本.sh'), '#!/bin/sh');
    fs.writeFileSync(outside, 'outside');
    const store = createKbSourceStore(dir);

    assert.deepEqual(
      (({ name, ext, kind }) => ({ name, ext, kind }))(store.resolve('员工休假管理办法.docx')),
      { name: '员工休假管理办法.docx', ext: 'docx', kind: 'Word' },
    );
    // 引用名不带类别前缀时，按 <前缀>_<引用名> 在原料区定位。
    assert.equal(store.resolve('/some/where/差旅管理办法.docx').name, '人力资源管理_员工管理_差旅管理办法.docx');
    assert.equal(store.resolve('报销制度.xlsx').kind, 'Excel');
    assert.equal(store.resolve('说明.txt').kind, '文本');
    assert.equal(store.resolve('脚本.sh'), null, '非预览类型不开放');
    assert.equal(store.resolve('不存在.docx'), null);
    // 带目录的引用名只取文件名，绝不会读到原料区之外。
    assert.equal(store.resolve('../outside.docx'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('missing input directory disables resolution instead of throwing', () => {
  const store = createKbSourceStore(path.join(os.tmpdir(), 'harness-kb-missing-' + Date.now()));
  assert.equal(store.enabled, false);
  assert.equal(store.resolve('任意.docx'), null);
});
