import type { Folder, Link, LinkDraft, Settings } from './types';

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
  createFolder: (name: string) => request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }),
  updateFolder: (id: string, name: string) => request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),
  reorderFolders: (ids: string[]) => request<void>('/api/folders/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  links: (folderId: string) => request<Link[]>(`/api/folders/${folderId}/links`),
  createLink: (folderId: string, draft: Pick<LinkDraft, 'url' | 'title' | 'description' | 'displayName'>) => request<Link>(`/api/folders/${folderId}/links`, { method: 'POST', body: JSON.stringify(draft) }),
  updateLink: (id: string, draft: Partial<LinkDraft>) => request<Link>(`/api/links/${id}`, { method: 'PATCH', body: JSON.stringify(draft) }),
  deleteLink: (id: string) => request<void>(`/api/links/${id}`, { method: 'DELETE' }),
  reorderLinks: (items: Array<{ id: string; folderId: string }>) => request<void>('/api/links/reorder', { method: 'POST', body: JSON.stringify({ items }) }),
  refreshMetadata: (id: string) => request<Link>(`/api/links/${id}/refresh-metadata`, { method: 'POST' }),
  click: (id: string) => request<void>(`/api/links/${id}/clicks`, { method: 'POST' }),
  settings: () => request<Settings>('/api/settings'),
  updateSettings: (settings: Settings) => request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
};
