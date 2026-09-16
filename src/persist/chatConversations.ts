import { kvGet, kvSet } from './sharedKv';
import type { PersistedChat } from './projectStore';

/** A lightweight archive around the currently active Agent session.
 *
 * The existing `chat:<project>` / `agent-session-chat:<project>:<generation>`
 * entries remain the source of truth for the running Agent.  This index gives
 * the UI multiple named conversations without changing the server runtime
 * protocol or deleting any of the existing persistence code.
 */
export interface ChatConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chat: PersistedChat;
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChatConversationStore {
  version: 1;
  activeId: string;
  conversations: ChatConversationRecord[];
}

const MAX_CONVERSATIONS = 30;
const conversationKey = (projectId: string) => `chat-conversations:${projectId}`;
const queues = new Map<string, Promise<void>>();

function enqueue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(projectId, settled);
  void settled.finally(() => {
    if (queues.get(projectId) === settled) queues.delete(projectId);
  });
  return run;
}

function conversationId(): string {
  try { return `conv_${crypto.randomUUID()}`; }
  catch { return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
}

function titleForChat(chat: PersistedChat, fallback = '新建对话'): string {
  const first = chat.messages.find((message) => {
    if (!message || typeof message !== 'object') return false;
    const row = message as { role?: unknown; text?: unknown };
    return row.role === 'user' && typeof row.text === 'string' && row.text.trim();
  }) as { text?: string } | undefined;
  const text = first?.text?.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

function isChat(value: unknown): value is PersistedChat {
  return !!value && typeof value === 'object'
    && Array.isArray((value as { messages?: unknown }).messages)
    && Array.isArray((value as { llm?: unknown }).llm);
}

function normalizeRecord(value: unknown): ChatConversationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ChatConversationRecord>;
  if (typeof row.id !== 'string' || !row.id || typeof row.title !== 'string'
      || typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number'
      || !isChat(row.chat)) return null;
  return {
    id: row.id,
    title: row.title || '新建对话',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    chat: row.chat,
  };
}

function normalizeStore(value: unknown): ChatConversationStore | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ChatConversationStore>;
  if (row.version !== 1 || typeof row.activeId !== 'string' || !Array.isArray(row.conversations)) return null;
  const conversations = row.conversations.map(normalizeRecord).filter((item): item is ChatConversationRecord => !!item);
  if (!conversations.length) return null;
  const activeId = conversations.some((item) => item.id === row.activeId)
    ? row.activeId
    : conversations[0]!.id;
  return { version: 1, activeId, conversations };
}

function bounded(store: ChatConversationStore): ChatConversationStore {
  const conversations = [...store.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  if (!conversations.some((item) => item.id === store.activeId)) {
    return { ...store, activeId: conversations[0]?.id ?? store.activeId, conversations };
  }
  return { ...store, conversations };
}

export function summarizeChatConversation(item: ChatConversationRecord): ChatConversationSummary {
  return {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    messageCount: item.chat.messages.length,
  };
}

export function summarizeChatConversations(store: ChatConversationStore): ChatConversationSummary[] {
  return store.conversations.map(summarizeChatConversation);
}

/** Load the archive, migrating the pre-existing single conversation on first use. */
export async function loadChatConversationStore(
  projectId: string,
  fallbackChat?: PersistedChat | null,
): Promise<ChatConversationStore> {
  await queues.get(projectId);
  return readChatConversationStore(projectId, fallbackChat);
}

async function readChatConversationStore(
  projectId: string,
  fallbackChat?: PersistedChat | null,
): Promise<ChatConversationStore> {
  const stored = normalizeStore(await kvGet<unknown>(conversationKey(projectId)));
  if (stored) return bounded(stored);
  const now = Date.now();
  const first: ChatConversationRecord = {
    id: conversationId(),
    title: titleForChat(fallbackChat ?? { messages: [], llm: [] }),
    createdAt: now,
    updatedAt: now,
    chat: fallbackChat ?? { messages: [], llm: [] },
  };
  const created = { version: 1 as const, activeId: first.id, conversations: [first] };
  await kvSet(conversationKey(projectId), created);
  return created;
}

export function saveChatConversationStore(projectId: string, store: ChatConversationStore): Promise<void> {
  const next = bounded(store);
  return enqueue(projectId, async () => { await kvSet(conversationKey(projectId), next); });
}

export function saveChatConversationSnapshot(
  projectId: string,
  conversationIdValue: string,
  chat: PersistedChat,
): Promise<ChatConversationStore> {
  return enqueue(projectId, async () => {
    const current = normalizeStore(await kvGet<unknown>(conversationKey(projectId)))
      ?? await readChatConversationStore(projectId, chat);
    const now = Date.now();
    const existing = current.conversations.find((item) => item.id === conversationIdValue);
    const nextRecord: ChatConversationRecord = existing
      ? { ...existing, title: titleForChat(chat, existing.title), updatedAt: now, chat }
      : { id: conversationIdValue, title: titleForChat(chat), createdAt: now, updatedAt: now, chat };
    const next = bounded({
      version: 1,
      activeId: current.activeId === conversationIdValue ? current.activeId : conversationIdValue,
      conversations: [nextRecord, ...current.conversations.filter((item) => item.id !== conversationIdValue)],
    });
    await kvSet(conversationKey(projectId), next);
    return next;
  });
}

export function setActiveChatConversation(projectId: string, id: string): Promise<ChatConversationStore> {
  return enqueue(projectId, async () => {
    const current = await readChatConversationStore(projectId);
    if (!current.conversations.some((item) => item.id === id)) return current;
    const next = { ...current, activeId: id };
    await kvSet(conversationKey(projectId), next);
    return next;
  });
}

export function createChatConversation(projectId: string): Promise<{ store: ChatConversationStore; conversation: ChatConversationRecord }> {
  return enqueue(projectId, async () => {
    const current = await readChatConversationStore(projectId);
    const now = Date.now();
    const conversation: ChatConversationRecord = {
      id: conversationId(), title: '新建对话', createdAt: now, updatedAt: now,
      chat: { messages: [], llm: [] },
    };
    const store = bounded({ version: 1, activeId: conversation.id, conversations: [conversation, ...current.conversations] });
    await kvSet(conversationKey(projectId), store);
    return { store, conversation };
  });
}

export function resetChatConversationMemory(): void { queues.clear(); }
