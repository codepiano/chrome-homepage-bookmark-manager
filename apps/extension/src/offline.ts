import { defaultSettings, type Folder, type Link, type TrashSnapshot } from './types';
import { rawRequest, getConnection, type LibrarySnapshot } from './api';

export const OFFLINE_KEY = 'editableLibrary';
const LOCK = 'local-speed-dial-library';
type Operation = { id: string; path: string; method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; entityId?: string };
type Deleted = { folders: Folder[]; links: Link[]; rootId?: string; deletedAt: string };
export interface OfflineState { snapshot: LibrarySnapshot; queue: Operation[]; deleted: Record<string, Deleted>; source: string; offline: boolean; error: string | null; }
export const withLibraryLock = async <T>(run: () => Promise<T>): Promise<T> => await navigator.locks.request(LOCK, run);
const emptySnapshot = (): LibrarySnapshot => ({ folders: [], linksByFolder: {}, settings: { ...defaultSettings } });
async function readState(): Promise<OfflineState> {
  const values = await chrome.storage.local.get([OFFLINE_KEY, 'lastGoodLibrarySnapshot']);
  const connection = await getConnection();
  const source = connection.apiBaseUrl;
  const saved = values[OFFLINE_KEY] as OfflineState | undefined;
  if (saved && saved.source !== source) {
    if (saved.queue.length) throw new Error('还有未同步的修改，请先连接原服务完成同步，再切换服务地址');
    return { snapshot: emptySnapshot(), queue: [], deleted: {}, source, offline: false, error: null };
  }
  return saved ?? { snapshot: (values.lastGoodLibrarySnapshot as LibrarySnapshot | undefined) ?? emptySnapshot(), queue: [], deleted: {}, source, offline: false, error: null };
}
async function writeState(state: OfflineState) {
  await chrome.storage.local.set({ [OFFLINE_KEY]: state, lastGoodLibrarySnapshot: state.snapshot });
}
async function flush(state: OfflineState) {
  while (state.queue.length) {
    await rawRequest('/api/sync/operation', { method: 'POST', body: JSON.stringify(state.queue[0]) });
    state.queue.shift();
    await writeState(state);
  }
}
// The lock is shared by all new-tab pages and the service worker. Snapshot and queue
// are persisted together before attempting the network, including on a first offline launch.
export async function syncLibrary(): Promise<OfflineState> {
  return withLibraryLock(async () => {
    const state = await readState();
    try {
      await flush(state);
      const [folders, settings] = await Promise.all([rawRequest<Folder[]>('/api/folders'), rawRequest<LibrarySnapshot['settings']>('/api/settings')]);
      const linksByFolder = Object.fromEntries(await Promise.all(folders.map(async folder => [folder.id, await rawRequest<Link[]>(`/api/folders/${folder.id}/links`)])));
      const cleanSettings = Object.fromEntries(Object.keys(defaultSettings).map(key => [key, settings[key as keyof typeof settings] ?? defaultSettings[key as keyof typeof defaultSettings]])) as unknown as LibrarySnapshot['settings'];
      state.snapshot = { folders, settings: cleanSettings, linksByFolder };
      state.deleted = {};
      state.offline = false; state.error = null;
    } catch (error) { state.offline = true; state.error = error instanceof Error ? error.message : '无法连接本机服务'; }
    await writeState(state);
    return state;
  });
}

function recount(snapshot: LibrarySnapshot) {
  for (const folder of snapshot.folders) folder.linkCount = (snapshot.linksByFolder[folder.id] ?? []).length;
}
function moveLink(snapshot: LibrarySnapshot, item: Link, folderId: string, position?: number) {
  if (!snapshot.folders.some(folder => folder.id === folderId)) throw new Error('目标标签不存在');
  snapshot.linksByFolder[item.folderId] = (snapshot.linksByFolder[item.folderId] ?? []).filter(link => link.id !== item.id);
  const target = snapshot.linksByFolder[folderId] ??= [];
  item.folderId = folderId; item.position = position ?? target.length;
  target.push(item); target.sort((a, b) => a.position - b.position);
}
function targetForUrl(snapshot: LibrarySnapshot, url: string, fallback: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  return snapshot.folders.find(folder => folder.systemRole !== 'inbox' && folder.autoRules.some(rule => rule.startsWith('*.') ? hostname === rule.slice(2) || hostname.endsWith(`.${rule.slice(2)}`) : hostname === rule))?.id ?? fallback;
}
function apply(state: OfflineState, op: Operation): unknown {
  const snapshot = state.snapshot;
  const allLinks = () => Object.values(snapshot.linksByFolder).flat();
  const folderById = (id: string) => { const folder = snapshot.folders.find(item => item.id === id); if (!folder) throw new Error('标签不存在'); return folder; };
  const linkById = (id: string) => { const link = allLinks().find(item => item.id === id); if (!link) throw new Error('链接不存在'); return link; };
  const checkParent = (id: string, parentId: string | null) => { let current = parentId; const seen = new Set([id]); while (current) { if (seen.has(current)) throw new Error('不能将标签移入自身或子标签'); seen.add(current); current = folderById(current).parentId; } };
  const { path, method } = op;
  // Bodies originate from typed API methods; validate editable values before persisting.
  const body = (op.body ?? {}) as Record<string, unknown>;
  const timestamp = new Date().toISOString();
  if (/^\/api\/(?:links\/[^/]+$|folders\/[^/]+\/links$)/.test(path)) {
    for (const key of ['title', 'description', 'displayName']) if (body[key] != null && (typeof body[key] !== 'string' || String(body[key]).length > 10000)) throw new Error('链接文字过长');
    if (body.url !== undefined && String(body.url).length > 4096) throw new Error('网址过长');
    if (body.faviconUrl && !/^https?:\/\//i.test(String(body.faviconUrl))) throw new Error('图标网址必须是 HTTP(S) 网址');
  }

  if (path === '/api/settings') {
    const next = { ...snapshot.settings, ...body };
    for (const [key, min, max] of [['columns', 1, 12], ['gap', 0, 96], ['cardWidth', 120, 800], ['tagSidebarWidth', 220, 480]] as const) {
      if (!Number.isFinite(next[key]) || next[key] < min || next[key] > max || ((key === 'columns' || key === 'tagSidebarWidth') && !Number.isInteger(next[key]))) throw new Error('显示设置数值超出范围');
    }
    snapshot.settings = next; return next;
  }
  if (path === '/api/folders/reorder') { const ids = body.ids as string[]; snapshot.folders = ids.map((id, position) => ({ ...folderById(id), parentId: null, position })); return; }
  if (path === '/api/folders/move') {
    const folder = folderById(String(body.id)); if (folder.systemRole === 'inbox') throw new Error('收集箱不能移动');
    const parentId = body.parentId as string | null; checkParent(folder.id, parentId);
    const siblings = snapshot.folders.filter(item => item.parentId === parentId && item.id !== folder.id);
    siblings.splice(Number(body.index), 0, folder); siblings.forEach((item, position) => { item.parentId = parentId; item.position = position; });
    snapshot.folders.sort((a, b) => a.position - b.position); return folder;
  }
  let match = path.match(/^\/api\/folders(?:\/([^/]+))?$/);
  if (match) {
    const id = match[1] ?? op.entityId!;
    if (method === 'DELETE') {
      if (folderById(id).systemRole === 'inbox') throw new Error('收集箱不能删除');
      const ids = new Set([id]); let count = -1;
      while (count !== ids.size) { count = ids.size; snapshot.folders.forEach(item => { if (item.parentId && ids.has(item.parentId)) ids.add(item.id); }); }
      state.deleted[id] = { folders: snapshot.folders.filter(item => ids.has(item.id)), links: allLinks().filter(item => ids.has(item.folderId)), rootId: id, deletedAt: timestamp };
      snapshot.folders = snapshot.folders.filter(item => !ids.has(item.id)); ids.forEach(id => delete snapshot.linksByFolder[id]); return;
    }
    const name = String(body.name ?? '').trim(); const autoRules = body.autoRules as string[];
    if (!name || name.length > 120) throw new Error('标签名称须为 1–120 个字符');
    if (autoRules.length > 50 || autoRules.some(rule => !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(rule))) throw new Error('自动归集规则必须是有效域名');
    const previous = match[1] ? folderById(id) : undefined;
    if (previous?.systemRole === 'inbox' && autoRules.length) throw new Error('收集箱不能设置自动归集规则');
    const parentId = body.parentId === undefined ? previous?.parentId ?? null : body.parentId as string | null; checkParent(id, parentId);
    const folder: Folder = { id, name, autoRules, parentId, systemRole: previous?.systemRole ?? null, position: previous?.position ?? snapshot.folders.filter(item => item.parentId === parentId).length, linkCount: previous?.linkCount ?? 0 };
    if (previous) Object.assign(previous, folder); else { snapshot.folders.push(folder); snapshot.linksByFolder[id] = []; }
    if (previous) for (const item of allLinks()) { if (folderById(item.folderId).systemRole === 'inbox') continue; const target = targetForUrl(snapshot, item.url, item.folderId); if (target !== item.folderId) moveLink(snapshot, item, target); }
    return previous ?? folder;
  }
  match = path.match(/^\/api\/folders\/([^/]+)\/links$/);
  if (match) {
    const folder = folderById(match[1]); const url = String(body.url); new URL(url);
    if (!/^(https?:\/\/|chrome:\/\/)/i.test(url)) throw new Error('只支持 HTTP(S) 或 Chrome 内部网址');
    const folderId = folder.systemRole === 'inbox' ? folder.id : targetForUrl(snapshot, url, folder.id);
    const items = snapshot.linksByFolder[folderId] ??= [];
    const link: Link = { id: op.entityId!, folderId, url, title: null, description: null, displayName: null, faviconUrl: null, appearanceOverride: null, metadataStatus: /^https?:/i.test(url) ? 'pending' : 'succeeded', metadataError: null, position: items.length, clickCount: 0, lastClickedAt: null, createdAt: timestamp, updatedAt: timestamp, healthStatus: 'unchecked', healthCheckedAt: null, healthHttpStatus: null, healthRedirectUrl: null, healthError: null, pinnedAt: null, ...body };
    items.push(link); return link;
  }
  if (path === '/api/links/move' || path === '/api/links/reorder') {
    const items = path.endsWith('/move') ? (body.ids as string[]).map(id => ({ id, folderId: String(body.folderId) })) : body.items as Array<{ id: string; folderId: string }>;
    const moved = items.map((item, index) => { const link = linkById(item.id); moveLink(snapshot, link, item.folderId, path.endsWith('/reorder') ? index : undefined); return link; });
    return { moved };
  }
  match = path.match(/^\/api\/links\/([^/]+)(?:\/(pin|clicks))?$/);
  if (match) {
    const item = linkById(match[1]);
    if (method === 'DELETE') { state.deleted[item.id] = { folders: [], links: [item], deletedAt: timestamp }; snapshot.linksByFolder[item.folderId] = snapshot.linksByFolder[item.folderId].filter(link => link.id !== item.id); return; }
    if (match[2] === 'pin') item.pinnedAt = body.pinned ? timestamp : null;
    else if (match[2] === 'clicks') { item.clickCount++; item.lastClickedAt = timestamp; }
    else { if (body.url !== undefined && !/^(https?:\/\/|chrome:\/\/)/i.test(String(body.url))) throw new Error('网址格式不正确'); if (body.url) new URL(String(body.url)); Object.assign(item, body); }
    item.updatedAt = timestamp; return item;
  }
  match = path.match(/^\/api\/trash\/(folders|links)\/([^/]+)\/restore$/);
  if (match) {
    const deleted = state.deleted[match[2]]; if (!deleted) throw new Error('请连接服务后恢复此项目');
    for (const folder of deleted.folders) { if (folder.parentId && !snapshot.folders.some(item => item.id === folder.parentId) && !deleted.folders.some(item => item.id === folder.parentId)) folder.parentId = null; snapshot.folders.push(folder); snapshot.linksByFolder[folder.id] = []; }
    for (const link of deleted.links) { if (!snapshot.folders.some(folder => folder.id === link.folderId)) throw new Error('请先恢复所属标签'); (snapshot.linksByFolder[link.folderId] ??= []).push(link); }
    delete state.deleted[match[2]]; return { restored: true };
  }
  throw new Error('此功能需要连接本机服务');
}
export function supportsOffline(path: string, method = 'GET') {
  if (['/api/links/merge', '/api/links/health-check'].includes(path)) return false;
  return method !== 'GET' && (/^\/api\/folders(?:\/[^/]+(?:\/links)?)?$/.test(path) || /^\/api\/links\/(?:move|reorder|[^/]+(?:\/(?:pin|clicks))?)$/.test(path) || path === '/api/settings' || /^\/api\/trash\/(folders|links)\/[^/]+\/restore$/.test(path));
}
export async function editLibrary<T>(path: string, init: RequestInit): Promise<T> {
  return withLibraryLock(async () => {
    const state = await readState();
    const operation: Operation = { id: crypto.randomUUID(), path, method: init.method as Operation['method'], ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
    if (path === '/api/folders' || /^\/api\/folders\/[^/]+\/links$/.test(path)) operation.entityId = crypto.randomUUID();
    const restore = path.match(/^\/api\/trash\/(?:folders|links)\/([^/]+)\/restore$/);
    if (restore && !state.deleted[restore[1]]) {
      // Older trash entries live on the service; only locally deleted entries
      // can be restored from the offline cache.
      await flush(state);
      return rawRequest<T>(path, init);
    }
    const result = apply(state, operation) as T;
    recount(state.snapshot); state.queue.push(operation);
    await writeState(state);
    // Wake the service worker after persistence. Edits return immediately even if a
    // service accepts TCP connections but never responds.
    void chrome.runtime.sendMessage({ type: 'sync-library' }).catch(() => undefined);
    return result;
  });
}
export async function readLibrary<T>(path: string): Promise<T | undefined> {
  return withLibraryLock(async () => {
    const state = await readState(); const snapshot = state.snapshot;
    if (path === '/api/folders') return snapshot.folders as T;
    if (path === '/api/settings') return snapshot.settings as T;
    const match = path.match(/^\/api\/folders\/([^/]+)\/links$/);
    if (match) return (snapshot.linksByFolder[match[1]] ?? []) as T;
    if (path.startsWith('/api/links/duplicates?')) return Object.values(snapshot.linksByFolder).flat().filter(item => item.url === new URLSearchParams(path.split('?')[1]).get('url')) as T;
    if (path === '/api/trash' && (state.offline || state.queue.length)) {
      const trash: TrashSnapshot = { folders: [], links: [] };
      for (const [id, deleted] of Object.entries(state.deleted)) {
        if (deleted.rootId) trash.folders.push({ id, name: deleted.folders.find(folder => folder.id === id)!.name, deletedAt: deleted.deletedAt, descendantCount: deleted.folders.length - 1, linkCount: deleted.links.length });
        else for (const link of deleted.links) trash.links.push({ id, url: link.url, title: link.displayName ?? link.title, folderName: snapshot.folders.find(folder => folder.id === link.folderId)?.name ?? '', deletedAt: deleted.deletedAt });
      }
      return trash as T;
    }
    return undefined;
  });
}
