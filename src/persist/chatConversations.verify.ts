import assert from 'node:assert';

const mem = new Map<string, unknown>();
const { configureSharedKvBackend, resetSharedKvMemory } = await import('./sharedKv');
configureSharedKvBackend({
  get: async <T,>(key: string) => mem.get(key) as T | undefined,
  set: async (key: string, value: unknown) => { mem.set(key, value); },
  delete: async (key: string) => { mem.delete(key); },
  keys: async () => [...mem.keys()],
  writeAgentRuntime: async () => { throw new Error('unused'); },
  updateAgentRunLease: async () => { throw new Error('unused'); },
});

const {
  createChatConversation,
  loadChatConversationStore,
  saveChatConversationSnapshot,
  setActiveChatConversation,
  summarizeChatConversations,
  resetChatConversationMemory,
} = await import('./chatConversations');

const projectId = 'chat-conversations-verify';
const legacy = {
  messages: [{ role: 'user', text: '保留这段已有聊天记录' }],
  llm: [{ role: 'user', content: '保留这段已有聊天记录' }],
};
const first = await loadChatConversationStore(projectId, legacy);
assert.equal(first.conversations.length, 1, 'the legacy session is migrated into one conversation');
assert.equal(first.conversations[0]?.title, '保留这段已有聊天记录');

const { store: withNew, conversation: fresh } = await createChatConversation(projectId);
assert.equal(withNew.activeId, fresh.id, 'new conversation becomes active');
assert.equal(withNew.conversations.length, 2, 'history retains the prior conversation');

const updated = {
  messages: [{ role: 'user', text: '新对话的第一条消息' }, { role: 'assistant', text: '收到' }],
  llm: [{ role: 'user', content: '新对话的第一条消息' }],
};
const saved = await saveChatConversationSnapshot(projectId, fresh.id, updated);
assert.equal(saved.conversations.find((item) => item.id === fresh.id)?.title, '新对话的第一条消息');
assert.equal(saved.conversations.find((item) => item.id === fresh.id)?.chat.messages.length, 2);

const switched = await setActiveChatConversation(projectId, first.activeId);
assert.equal(switched.activeId, first.activeId, 'selecting a history item changes the active conversation');
assert.equal(summarizeChatConversations(switched).length, 2);

resetChatConversationMemory();
resetSharedKvMemory();
console.log('chatConversations.verify: legacy migration, new conversation, archive and switch all pass');

