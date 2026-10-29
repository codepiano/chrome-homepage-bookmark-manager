import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/db.js';
import { createServer } from '../src/server.js';

test('offline edits replay in order, retain client IDs and deduplicate across server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-dial-offline-'));
  let store = new Store(join(dir, 'library.sqlite'));
  let app = createServer({ store, token: 'test' });
  const headers = { authorization: 'Bearer test' };
  const folderId = randomUUID(), childId = randomUUID(), linkId = randomUUID();
  const create = { id: randomUUID(), path: '/api/folders', method: 'POST', body: { name: 'Offline', autoRules: [] }, entityId: folderId };
  const send = (payload: unknown) => app.inject({ method: 'POST', url: '/api/sync/operation', payload, headers });
  const edit = (path: string, method: string, body?: unknown, entityId?: string) => send({ id: randomUUID(), path, method, body, entityId });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/sync/operation', payload: create })).statusCode, 401);
    assert.equal((await send(create)).json().id, folderId);
    assert.equal((await send(create)).statusCode, 200);
    assert.equal(store.listFolders().length, 1);
    await app.close(); store.close();
    store = new Store(join(dir, 'library.sqlite')); app = createServer({ store, token: 'test' });
    assert.equal((await send(create)).json().id, folderId);
    assert.equal(store.listFolders().length, 1);
    assert.equal((await edit('/api/folders', 'POST', { name: 'Child', parentId: folderId }, childId)).statusCode, 200);
    assert.equal((await edit(`/api/folders/${childId}/links`, 'POST', { url: 'chrome://extensions' }, linkId)).json().id, linkId);
    assert.equal((await edit(`/api/links/${linkId}`, 'PATCH', { displayName: 'Edited offline' })).json().displayName, 'Edited offline');
    const click = { id: randomUUID(), path: `/api/links/${linkId}/clicks`, method: 'POST' };
    await send(click); await send(click);
    assert.equal(store.getLink(linkId)?.clickCount, 1);
    assert.equal((await edit('/api/links/move', 'POST', { ids: [linkId], folderId })).statusCode, 200);
    assert.equal(store.getLink(linkId)?.folderId, folderId);
    assert.equal((await edit(`/api/folders/${folderId}`, 'DELETE')).statusCode, 200);
    assert.equal(store.getLink(linkId), undefined);
    assert.equal((await edit(`/api/trash/folders/${folderId}/restore`, 'POST')).json().restored, true);
    assert.equal(store.getFolder(childId)?.parentId, folderId);
    assert.equal(store.getLink(linkId)?.displayName, 'Edited offline');
    const other = store.createFolder('Created elsewhere');
    assert.equal((await edit('/api/folders/reorder', 'POST', { ids: [childId, folderId] })).statusCode, 200);
    assert.ok(store.getFolder(other.id));
    const invalid = await edit(`/api/links/${linkId}`, 'PATCH', { url: 'javascript:alert(1)' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(store.getLink(linkId)?.url, 'chrome://extensions');
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed offline operation rolls back its edits and receipt atomically', () => {
  const store = new Store(':memory:');
  try {
    const id = randomUUID();
    assert.throws(() => store.applyOnce(id, { action: 'test' }, () => { store.createFolder('Rolled back'); throw new Error('interrupted'); }));
    assert.equal(store.listFolders().length, 0);
    const result = store.applyOnce(id, { action: 'test' }, () => store.createFolder('Retried'));
    assert.ok(result);
    assert.equal(store.listFolders().length, 1);
  } finally { store.close(); }
});
