export function assistantDelta(messages, id, text, metadata = {}) {
  const existing = messages.find(m => m.id === id);
  return existing ? messages.map(m => m.id === id ? { ...m, content: m.content + text, streaming: true } : m)
    : [...messages, { id, role: 'assistant', content: text, instant: true, streaming: true, ...metadata }];
}

export function assistantComplete(messages, id, text, metadata = {}) {
  return messages.some(m => m.id === id)
    ? messages.map(m => m.id === id ? { ...m, content: text, streaming: false, instant: true } : m)
    : [...messages, { id, role: 'assistant', content: text, instant: true, streaming: false, ...metadata }];
}

export function safeToolDetails(value) {
  return JSON.stringify(value, (key, item) => /password|secret|api.?key|authorization|cookie|judgment_token/i.test(key)
    ? '[已隐藏]' : item, 2)?.slice(0, 4000) || '';
}

export const isTruncatedToolResult = text => /Output truncated|Full output (?:written|saved)|Use read with offset\/limit/i.test(text || '');
