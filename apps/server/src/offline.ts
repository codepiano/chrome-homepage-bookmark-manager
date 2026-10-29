import { z } from 'zod';
import type { Store } from './db.js';

const uuid = z.string().uuid();
const text = z.string().max(10_000).nullable().optional();
const url = z.string().url().max(4096).refine(value => /^(https?:\/\/|chrome:\/\/)/i.test(value));
const appearance = z.object({ accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), cardColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), icon: z.string().trim().max(8).optional() }).strict().nullable().optional();
const folder = z.object({ name: z.string().trim().min(1).max(120), autoRules: z.array(z.string().trim().toLowerCase().regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).max(50).default([]), parentId: uuid.nullable().optional() }).strict();
const link = z.object({ url, title: text, description: text, displayName: text, appearanceOverride: appearance }).strict();
const updateLink = link.partial().extend({ faviconUrl: z.string().url().refine(value => /^https?:\/\//i.test(value)).nullable().optional() });
export const offlineEnvelope = z.object({ id: uuid, path: z.string().max(300), method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']), body: z.unknown().optional(), entityId: uuid.optional() }).strict();

// Apply only explicit user edits. Unrelated server data is never replaced by a cached library.
export function applyOfflineOperation(store: Store, operation: z.infer<typeof offlineEnvelope>, parseSettings: (value: unknown) => Record<string, unknown>): unknown {
  const { path, method, body, entityId } = operation;
  const requireValue = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('同步目标已不存在，请检查服务端数据'); return value; };
  if (path === '/api/settings' && method === 'PUT') return store.setSettings(parseSettings(body));
  if (path === '/api/folders' && method === 'POST') { const input = folder.parse(body); return store.createFolder(input.name, input.autoRules, input.parentId ?? null, requireValue(entityId)); }
  if (path === '/api/folders/move' && method === 'POST') { const input = z.object({ id: uuid, parentId: uuid.nullable(), index: z.number().int().min(0) }).strict().parse(body); return store.moveFolder(input.id, input.parentId, input.index); }
  if (path === '/api/folders/reorder' && method === 'POST') {
    const { ids } = z.object({ ids: z.array(uuid) }).strict().parse(body);
    // Keep folders created by another client while this client was disconnected.
    const current = store.listFolders().map(item => item.id);
    return store.reorderFolders([...ids.filter(id => current.includes(id)), ...current.filter(id => !ids.includes(id))]);
  }
  let match = path.match(/^\/api\/folders\/([^/]+)$/);
  if (match) {
    const id = uuid.parse(match[1]); const found = store.getFolder(id);
    if (!found && method === 'DELETE') return { ok: true };
    const current = requireValue(found);
    if (method === 'PATCH') { const input = folder.parse(body); if (current.systemRole === 'inbox' && input.autoRules.length) throw new Error('收集箱不能设置自动归集规则'); return requireValue(store.updateFolder(id, input)).folder; }
    if (method === 'DELETE') { if (current.systemRole === 'inbox') throw new Error('收集箱不能删除'); store.deleteFolder(id); return { ok: true }; }
  }
  match = path.match(/^\/api\/folders\/([^/]+)\/links$/);
  if (match && method === 'POST') return requireValue(store.createLink(uuid.parse(match[1]), link.parse(body), { id: requireValue(entityId) }));
  if (path === '/api/links/reorder' && method === 'POST') { const input = z.object({ items: z.array(z.object({ id: uuid, folderId: uuid }).strict()).min(1) }).strict().parse(body); store.reorderLinks(input.items); return { ok: true }; }
  if (path === '/api/links/move' && method === 'POST') { const input = z.object({ ids: z.array(uuid).min(1).max(1000), folderId: uuid }).strict().parse(body); return { moved: store.moveLinksToFolder(input.ids, input.folderId) }; }
  match = path.match(/^\/api\/links\/([^/]+)$/);
  if (match) {
    const id = uuid.parse(match[1]);
    if (!store.getLink(id) && method === 'DELETE') return { ok: true };
    requireValue(store.getLink(id));
    if (method === 'PATCH') { const input = updateLink.parse(body); const result = store.updateLink(id, input); return input.url ? store.resetLinkHealth(id) : result; }
    if (method === 'DELETE') { store.deleteLink(id); return { ok: true }; }
  }
  match = path.match(/^\/api\/links\/([^/]+)\/(pin|clicks)$/);
  if (match && method === 'POST') { const id = uuid.parse(match[1]); return requireValue(match[2] === 'pin' ? store.setLinkPinned(id, z.object({ pinned: z.boolean() }).strict().parse(body).pinned) : store.recordClick(id)); }
  match = path.match(/^\/api\/trash\/(folders|links)\/([^/]+)\/restore$/);
  if (match && method === 'POST') { const id = uuid.parse(match[2]); return { restored: match[1] === 'folders' ? store.restoreFolder(id) : store.restoreLink(id) }; }
  throw new Error('不支持的离线操作');
}
