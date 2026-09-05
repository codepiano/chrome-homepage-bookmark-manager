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
  assert.ok(store.setLinkPinned(link.id,true)?.pinnedAt);
  assert.equal(store.setLinkPinned(link.id,false)?.pinnedAt,null);
  store.reorderLinks([{id:link.id,folderId:two.id}]);
  assert.deepEqual(store.listLinks(one.id), []);
  assert.equal(store.listLinks(two.id)[0]?.folderId, two.id);
  store.reorderFolders([two.id,one.id]);
  assert.deepEqual(store.listFolders().map(folder=>folder.id), [two.id,one.id]);
  store.deleteFolder(two.id);
  assert.equal(store.getLink(link.id), undefined);
  assert.equal(store.listTrash().folders[0]?.id, two.id);
  assert.equal(store.restoreFolder(two.id), true);
  assert.equal(store.getLink(link.id)?.folderId, two.id);
  store.deleteLink(link.id);
  assert.equal(store.getLink(link.id), undefined);
  assert.equal(store.listTrash().links[0]?.id, link.id);
  assert.equal(store.restoreLink(link.id), true);
  assert.equal(store.getLink(link.id)?.folderId, two.id);
  store.close();
});

test('folder domain rules collect existing links and route newly added links', () => {
  const store = createStore();
  const inbox = store.createFolder('Inbox');
  const github = store.createFolder('GitHub');
  const existing = store.createLink(inbox.id, { url: 'https://api.github.com/repos/openai' })!;
  const unrelated = store.createLink(inbox.id, { url: 'https://example.com' })!;

  const result = store.updateFolder(github.id, { name: 'GitHub', autoRules: ['*.github.com'] });
  assert.equal(result?.moved, 1);
  assert.equal(store.getLink(existing.id)?.folderId, github.id);
  assert.equal(store.getLink(unrelated.id)?.folderId, inbox.id);

  const added = store.createLink(inbox.id, { url: 'https://github.com/openai' })!;
  assert.equal(added.folderId, github.id);
  store.close();
});

test('duplicate merge transfers clicks and restore reverses the transfer', () => {
  const store = createStore(); const folder = store.createFolder('Duplicates');
  const keep = store.createLink(folder.id, { url:'https://example.com/merge', title:'Keep' })!;
  const source = store.createLink(folder.id, { url:'https://example.com/merge', description:'Merged description' })!;
  store.recordClick(keep.id); store.recordClick(source.id); store.recordClick(source.id);
  const result = store.mergeLinks(keep.id, [source.id]);
  assert.equal(result.kept.clickCount, 3);
  assert.equal(result.kept.description, 'Merged description');
  assert.equal(store.getLink(source.id), undefined);
  assert.equal(store.restoreLink(source.id), true);
  assert.equal(store.getLink(keep.id)?.clickCount, 1);
  assert.equal(store.getLink(source.id)?.clickCount, 2);
  store.close();
});

test('library snapshots restore folders, links, ordering and settings', () => {
  const store=createStore(); const folder=store.createFolder('Snapshot folder'); const link=store.createLink(folder.id,{url:'https://example.com/snapshot',title:'Snapshot link'})!;
  store.setSettings({accentColor:'#123456'}); const snapshot=store.createSnapshot('Before changes');
  store.updateFolder(folder.id,{name:'Changed folder',autoRules:[]}); store.deleteLink(link.id); const extra=store.createFolder('Extra folder'); store.setSettings({accentColor:'#654321'});
  assert.equal(store.restoreSnapshot(snapshot.id),true);
  assert.equal(store.getFolder(folder.id)?.name,'Snapshot folder'); assert.equal(store.getLink(link.id)?.title,'Snapshot link'); assert.equal(store.getFolder(extra.id),undefined); assert.equal(store.getSettings().accentColor,'#123456');
  assert.equal(store.listSnapshots()[0]?.kind,'pre_restore'); store.close();
});

test('inbox is stable, bypasses automatic rules, and supports batch moves', () => {
  const store = createStore();
  const github = store.createFolder('GitHub', ['*.github.com']);
  const inbox = store.ensureInboxFolder();
  assert.equal(inbox.systemRole, 'inbox');
  assert.equal(store.ensureInboxFolder().id, inbox.id);
  assert.equal(store.listFolders()[0]?.id, inbox.id);

  const captured = store.createLink(inbox.id, { url: 'https://github.com/openai', title: 'OpenAI' }, { applyAutoRules: false })!;
  assert.equal(captured.folderId, inbox.id);
  store.updateFolder(github.id, { name: 'GitHub projects', autoRules: ['*.github.com'] });
  assert.equal(store.getLink(captured.id)?.folderId, inbox.id);
  const [moved] = store.moveLinksToFolder([captured.id], github.id);
  assert.equal(moved?.folderId, github.id);
  assert.equal(store.deleteFolder(inbox.id), false);
  store.close();
});
