/** Never report success until a browser clipboard operation actually succeeds. */
export async function copyText(text, { navigator: nav = globalThis.navigator, document: doc = globalThis.document } = {}) {
  if (typeof nav?.clipboard?.writeText === 'function') {
    try { await nav.clipboard.writeText(text); return; }
    catch { /* Older browsers or denied permissions may still allow a user-initiated copy. */ }
  }
  if (!doc || typeof doc.execCommand !== 'function') throw new Error('浏览器无法复制，请手动选择文字复制');
  const previous = doc.activeElement;
  const field = doc.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  doc.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!doc.execCommand('copy')) throw new Error('复制失败，请手动选择文字复制');
  } finally {
    field.remove();
    previous?.focus?.({ preventScroll: true });
  }
}
