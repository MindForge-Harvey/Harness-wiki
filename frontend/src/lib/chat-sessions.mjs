const stateFields = ['sessionId', 'messages', 'timeline', 'draft', 'attachment', 'selectedSkills', 'isThinking', 'activityText'];

/** Conversation state outlives selection; stream callbacks always update their originating view. */
export function createChatSessions() {
  const listeners = new Set(), runtimes = new Map(), bindings = new Map(), aliases = new Map();
  let serial = 0, snapshot = { activeKey: null, views: new Map() };
  const emit = () => listeners.forEach(listener => listener());
  const store = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    get: key => snapshot.views.get(key),
    find: sessionId => aliases.get(sessionId),
    refs: key => runtimes.get(key),
    patch(key, update) {
      const current = snapshot.views.get(key);
      if (!current) return;
      const next = { ...current, ...(typeof update === 'function' ? update(current) : update) };
      if (next.sessionId) aliases.set(next.sessionId, key);
      snapshot = { ...snapshot, views: new Map(snapshot.views).set(key, next) };
      emit();
    },
    bind(key) {
      if (!bindings.has(key)) bindings.set(key, Object.fromEntries(stateFields.map(field => [
        'set' + field[0].toUpperCase() + field.slice(1),
        value => store.patch(key, current => ({ [field]: typeof value === 'function' ? value(current[field]) : value })),
      ])));
      return bindings.get(key);
    },
    create(sessionId = null) {
      const existing = sessionId && aliases.get(sessionId);
      if (existing) return existing;
      const key = `conversation-${++serial}`;
      const runtime = Object.fromEntries(['abort', 'assistantStream', 'pendingUserText', 'currentQueryId', 'currentUserText']
        .map(name => [name + 'Ref', { current: null }]));
      for (const name of ['streamSerial', 'sessionSeq', 'timelineId', 'historyRequest']) runtime[name + 'Ref'] = { current: 0 };
      for (const name of ['timelineCall', 'timelineApproval']) runtime[name + 'Ref'] = { current: new Map() };
      runtimes.set(key, runtime);
      store.patchNew(key, { key, sessionId, messages: [], timeline: [], draft: '', attachment: null, selectedSkills: [],
        isThinking: false, activityText: '', historyLoaded: !sessionId, historyLoading: false });
      return key;
    },
    patchNew(key, view) {
      if (view.sessionId) aliases.set(view.sessionId, key);
      snapshot = { ...snapshot, views: new Map(snapshot.views).set(key, view) };
      emit();
    },
    activate(key) {
      if (!snapshot.views.has(key)) throw new Error('会话不存在');
      snapshot = { ...snapshot, activeKey: key };
      emit();
    },
    newChat() { const key = store.create(); store.activate(key); return key; },
    dispose() {
      listeners.clear();
      for (const runtime of runtimes.values()) runtime.abortRef.current?.();
    },
  };
  store.newChat();
  return store;
}
