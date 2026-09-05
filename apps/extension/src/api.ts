import type { BrowserHistoryPage, Folder, LibrarySnapshotVersion, Link, LinkAppearance, LinkDraft, Recommendation, Settings, TrashSnapshot } from './types';

export interface ConnectionPreferences { apiBaseUrl: string; token: string; }
export const defaultConnection: ConnectionPreferences = { apiBaseUrl: 'http://127.0.0.1:3721', token: '' };

const storage = chrome.storage.local;
export async function getConnection(): Promise<ConnectionPreferences> {
  const saved = await storage.get(defaultConnection);
  return { apiBaseUrl: String(saved.apiBaseUrl).replace(/\/$/, ''), token: String(saved.token) };
}
export async function saveConnection(value: ConnectionPreferences) { await storage.set(value); }

const SNAPSHOT_KEY = 'lastGoodLibrarySnapshot';
export interface LibrarySnapshot {
  folders: Folder[];
  linksByFolder: Record<string, Link[]>;
  settings: Settings;
}

export async function getLastGoodSnapshot(): Promise<LibrarySnapshot | null> {
  const value = await storage.get(SNAPSHOT_KEY);
  return (value[SNAPSHOT_KEY] as LibrarySnapshot | undefined) ?? null;
}

export async function saveLastGoodSnapshot(snapshot: LibrarySnapshot) {
  await storage.set({ [SNAPSHOT_KEY]: snapshot });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiBaseUrl, token } = await getConnection();
  const hasJsonBody = init?.body !== undefined && init.body !== null;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { ...(hasJsonBody ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = await response.json() as { message?: string; error?: { message?: string } };
      message = payload.error?.message ?? payload.message ?? message;
    } catch { /* response was not JSON */ }
    throw new Error(message);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  folders: () => request<Folder[]>('/api/folders'),
  createFolder: (input: Pick<Folder, 'name' | 'autoRules'> & { parentId?: string | null }) => request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify(input) }),
  updateFolder: (id: string, input: Pick<Folder, 'name' | 'autoRules'> & { parentId?: string | null }) => request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),
  reorderFolders: (ids: string[]) => request<void>('/api/folders/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  moveFolder: (id: string, parentId: string | null, index: number) => request<Folder>('/api/folders/move', { method: 'POST', body: JSON.stringify({ id, parentId, index }) }),
  links: (folderId: string) => request<Link[]>(`/api/folders/${folderId}/links`),
  createLink: (folderId: string, draft: Pick<LinkDraft, 'url' | 'title' | 'description' | 'displayName' | 'appearanceOverride'>) => request<Link>(`/api/folders/${folderId}/links`, { method: 'POST', body: JSON.stringify(draft) }),
  updateLink: (id: string, draft: Partial<LinkDraft> & { appearanceOverride?: LinkAppearance | null }) => request<Link>(`/api/links/${id}`, { method: 'PATCH', body: JSON.stringify(draft) }),
  deleteLink: (id: string) => request<void>(`/api/links/${id}`, { method: 'DELETE' }),
  reorderLinks: (items: Array<{ id: string; folderId: string }>) => request<void>('/api/links/reorder', { method: 'POST', body: JSON.stringify({ items }) }),
  refreshMetadata: (id: string) => request<Link>(`/api/links/${id}/refresh-metadata`, { method: 'POST' }),
  duplicates: (url: string) => request<Link[]>(`/api/links/duplicates?url=${encodeURIComponent(url)}`),
  recommendations: () => request<{ recommendations: Recommendation[] }>('/api/recommendations'),
  trash: () => request<TrashSnapshot>('/api/trash'),
  restoreFolder: (id: string) => request<{ restored: boolean }>(`/api/trash/folders/${id}/restore`, { method: 'POST' }),
  restoreLink: (id: string) => request<{ restored: boolean }>(`/api/trash/links/${id}/restore`, { method: 'POST' }),
  moveLinks: (ids: string[], folderId: string) => request<{ moved: Link[] }>('/api/links/move', { method: 'POST', body: JSON.stringify({ ids, folderId }) }),
  mergeLinks: (keepId: string, mergeIds: string[]) => request<{ kept: Link; merged: number }>('/api/links/merge', { method: 'POST', body: JSON.stringify({ keepId, mergeIds }) }),
  checkLinkHealth: (ids: string[]) => request<{ checked: Link[] }>('/api/links/health-check', { method: 'POST', body: JSON.stringify({ ids }) }),
  applyLinkRedirect: (id: string) => request<Link>(`/api/links/${id}/apply-redirect`, { method: 'POST' }),
  history: (query = '', cursor?: { time: number; url: string }) => { const params = new URLSearchParams({ query, limit: '50' }); if (cursor) { params.set('cursorTime', String(cursor.time)); params.set('cursorUrl', cursor.url); } return request<{ items: BrowserHistoryPage[]; nextCursor: { time: number; url: string } | null }>(`/api/history?${params}`); },
  deleteHistory: (url: string) => request<{ deleted: boolean }>(`/api/history?url=${encodeURIComponent(url)}`, { method: 'DELETE' }),
  click: (id: string) => request<Link>(`/api/links/${id}/clicks`, { method: 'POST' }),
  pinLink: (id: string, pinned: boolean) => request<Link>(`/api/links/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) }),
  settings: () => request<Settings>('/api/settings'),
  updateSettings: (settings: Partial<Settings>) => request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  snapshots: () => request<LibrarySnapshotVersion[]>('/api/snapshots'),
  createSnapshot: (label: string) => request<LibrarySnapshotVersion>('/api/snapshots', { method:'POST', body:JSON.stringify({label}) }),
  restoreSnapshot: (id: string) => request<{restored:boolean}>(`/api/snapshots/${id}/restore`, { method:'POST' }),
};
