import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from './types';

let values: Record<string, unknown>;
let online: boolean;
let loseResponse: boolean;
let server: { folders: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };
let receipts: Map<string, unknown>;
let lock: Promise<unknown>;
beforeEach(() => {
  vi.resetModules();
  values = {}; online = false; loseResponse = false; server = { folders: [], links: [] }; receipts = new Map(); lock = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => Promise<unknown>) => { const result = lock.then(run); lock = result.catch(() => undefined); return result; } } });
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) }, storage: { local: {
    get: async (keys: string | string[] | Record<string, unknown>) => {
      if (typeof keys === 'string') return structuredClone({ [keys]: values[keys] });
      if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map(key => [key, values[key]])));
      return structuredClone({ ...keys, ...values });
    },
    set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); },
  } } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    const path = new URL(input).pathname;
    if (path === '/api/sync/operation') {
      const op = JSON.parse(String(init?.body));
      let result = receipts.get(op.id);
      if (!receipts.has(op.id)) {
        if (op.path === '/api/folders') { result = { ...op.body, id: op.entityId, parentId: null, position: server.folders.length, systemRole: null }; server.folders.push(result as Record<string, unknown>); }
        else if (/\/folders\/[^/]+\/links$/.test(op.path)) { result = { ...op.body, id: op.entityId, folderId: op.path.split('/')[3] }; server.links.push(result as Record<string, unknown>); }
        else if (/\/links\/[^/]+$/.test(op.path)) { result = server.links.find(link => link.id === op.path.split('/')[3]); Object.assign(result as object, op.body); }
        else result = {};
        receipts.set(op.id, result);
      }
      if (loseResponse) { loseResponse = false; throw new TypeError('Response lost after commit'); }
      return new Response(JSON.stringify(result));
    }
    if (path === '/api/folders') return new Response(JSON.stringify(server.folders));
    if (path === '/api/settings') return new Response(JSON.stringify({ ...defaultSettings, updatedAt: 'server timestamp' }));
    if (/\/folders\/[^/]+\/links$/.test(path)) return new Response(JSON.stringify(server.links.filter(link => link.folderId === path.split('/')[3])));
    return new Response('{}');
  }));
});

it('persists offline edits across module reload then replays dependent creates and updates', async () => {
  const { api } = await import('./api');
  const { syncLibrary } = await import('./offline');
  await syncLibrary();
  const folder = await api.createFolder({ name: 'Offline', autoRules: [] });
  const link = await api.createLink(folder.id, { url: 'chrome://extensions', title: null, description: null, displayName: null, appearanceOverride: null });
  await api.updateLink(link.id, { displayName: 'Renamed offline' });
  vi.resetModules();
  const reloaded = await import('./api');
  expect((await reloaded.api.links(folder.id))[0].displayName).toBe('Renamed offline');
  online = true;
  const result = await (await import('./offline')).syncLibrary();
  expect(result.queue).toHaveLength(0);
  expect(result.offline).toBe(false);
  expect(server.folders).toHaveLength(1);
  expect(server.links[0]).toMatchObject({ id: link.id, folderId: folder.id, displayName: 'Renamed offline' });
  expect(result.snapshot.settings).not.toHaveProperty('updatedAt');
});

it('keeps an unacknowledged edit and safely retries after a lost response', async () => {
  const { api } = await import('./api');
  const { syncLibrary } = await import('./offline');
  await api.createFolder({ name: 'Once', autoRules: [] });
  online = true; loseResponse = true;
  const failed = await syncLibrary();
  expect(failed.queue).toHaveLength(1);
  expect(server.folders).toHaveLength(1);
  expect((await syncLibrary()).queue).toHaveLength(0);
  expect(server.folders).toHaveLength(1);
});

it('serializes simultaneous tab edits without losing either operation', async () => {
  const { api } = await import('./api');
  const [one, two] = await Promise.all([api.createFolder({ name: 'One', autoRules: [] }), api.createFolder({ name: 'Two', autoRules: [] })]);
  expect((await api.folders()).map(folder => folder.id)).toEqual([one.id, two.id]);
  expect((values.editableLibrary as { queue: unknown[] }).queue).toHaveLength(2);
});

it('supports offline subtree deletion and undo without dropping descendants', async () => {
  const { api } = await import('./api');
  const root = await api.createFolder({ name: 'Root', autoRules: [] });
  const child = await api.createFolder({ name: 'Child', autoRules: [], parentId: root.id });
  const link = await api.createLink(child.id, { url: 'chrome://extensions', title: null, description: null, displayName: null, appearanceOverride: null });
  await expect(api.moveFolder(root.id, child.id, 0)).rejects.toThrow('子标签');
  await api.deleteFolder(root.id);
  expect(await api.folders()).toHaveLength(0);
  expect((await api.trash()).folders[0].descendantCount).toBe(1);
  await api.restoreFolder(root.id);
  expect((await api.links(child.id))[0].id).toBe(link.id);
});

it('keeps queued changes bound to their original service and rejects invalid edits', async () => {
  const { api, saveConnection } = await import('./api');
  await expect(api.createFolder({ name: '', autoRules: [] })).rejects.toThrow();
  expect(values.editableLibrary).toBeUndefined();
  await api.createFolder({ name: 'Local', autoRules: [] });
  await expect(saveConnection({ apiBaseUrl: 'http://localhost:9999', token: '' })).rejects.toThrow('原服务');
  await expect(api.updateSettings({ columns: 0 })).rejects.toThrow('超出范围');
  expect((values.editableLibrary as { queue: unknown[] }).queue).toHaveLength(1);
});

it('restores older service trash through the original endpoint after synchronizing local edits', async () => {
  const { api } = await import('./api');
  await api.createFolder({ name: 'Waiting', autoRules: [] });
  online = true;
  await api.restoreLink('b23e07c5-7df6-42b5-9e7e-f2ce507c22a8');
  expect((values.editableLibrary as { queue: unknown[] }).queue).toHaveLength(0);
  expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:3721/api/trash/links/b23e07c5-7df6-42b5-9e7e-f2ce507c22a8/restore', expect.objectContaining({ method: 'POST' }));
});

it('retains edits and exposes the server error when synchronization is rejected', async () => {
  const { api } = await import('./api');
  const { syncLibrary } = await import('./offline');
  await api.createFolder({ name: 'Keep me', autoRules: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: '配对令牌已过期' } }), { status: 401 })));
  const result = await syncLibrary();
  expect(result.queue).toHaveLength(1);
  expect(result.snapshot.folders[0].name).toBe('Keep me');
  expect(result.error).toBe('配对令牌已过期');
});
