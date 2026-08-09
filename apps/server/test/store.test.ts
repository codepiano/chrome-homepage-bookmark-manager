import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/db.js';

function createStore() { return new Store(join(mkdtempSync(join(tmpdir(), 'speed-dial-test-')), 'bookmarks.sqlite')); }

test('folders, links, ordering and click aggregates persist in SQLite', () => {
  const store=createStore();
  const one=store.createFolder('One'); const two=store.createFolder('Two');
  const link=store.createLink(one.id, { url: 'https://example.com', title: 'Example', description: 'An example link' })!;
  assert.equal(link.title, 'Example');
  assert.equal(link.description, 'An example link');
  store.recordClick(link.id); store.recordClick(link.id);
  assert.equal(store.getLink(link.id)?.clickCount, 2);
  store.reorderLinks([{id:link.id,folderId:two.id}]);
  assert.deepEqual(store.listLinks(one.id), []);
  assert.equal(store.listLinks(two.id)[0]?.folderId, two.id);
  store.reorderFolders([two.id,one.id]);
  assert.deepEqual(store.listFolders().map(folder=>folder.id), [two.id,one.id]);
  store.deleteFolder(two.id);
  assert.equal(store.getLink(link.id), undefined);
  store.close();
});
