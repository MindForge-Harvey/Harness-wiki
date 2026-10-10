import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../src/lib/copy-text.mjs';

function fallback(succeeds) {
  let removed = false;
  let selected = false;
  const field = { style: {}, focus() {}, select() { selected = true; }, remove() { removed = true; } };
  return {
    document: { body: { appendChild() {} }, createElement() { return field; }, execCommand(command) { assert.equal(command, 'copy'); return succeeds; } },
    check(text) { assert.equal(field.value, text); assert.ok(removed && selected); },
  };
}

test('copy writes the full answer to the clipboard', async () => {
  let copied;
  await copyText('完整回答\n包括来源', { navigator: { clipboard: { writeText: async text => { copied = text; } } } });
  assert.equal(copied, '完整回答\n包括来源');
});

test('missing clipboard APIs use a real browser copy, not a no-op', async () => {
  const env = fallback(true);
  await copyText('回答', { navigator: {}, document: env.document });
  env.check('回答');
});

test('denied clipboard permissions fall back to a user-initiated copy', async () => {
  const env = fallback(true);
  await copyText('回答', { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, document: env.document });
  env.check('回答');
});

test('a failed copy rejects and cleans up rather than reporting success', async () => {
  const env = fallback(false);
  await assert.rejects(copyText('回答', { navigator: {}, document: env.document }), /复制失败/);
  env.check('回答');
  await assert.rejects(copyText('回答', { navigator: {}, document: null }), /浏览器无法复制/);
});
