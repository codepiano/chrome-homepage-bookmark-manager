import Fastify from 'fastify';
import { z } from 'zod';
import type { Store } from './db.js';
import { fetchMetadata, MetadataError } from './metadata.js';

const id = z.string().uuid();
const httpUrl = z.string().url().max(4096).refine(value => /^https?:\/\//i.test(value), 'Only HTTP(S) URLs are accepted');
function normalizeLinkUrl(value: unknown) {
  if (typeof value !== 'string') return value;
  const url = value.trim();
  return url && !/^[a-z][a-z\d+.-]*:/i.test(url) ? `https://${url}` : url;
}
const linkUrl = z.preprocess(normalizeLinkUrl, z.string().url().max(4096).refine(value => /^(https?:\/\/|chrome:\/\/)/i.test(value), 'Only HTTP(S) and Chrome internal URLs are accepted'));
const nullableText = z.string().max(10_000).nullable();
const autoRule = z.string().trim().toLowerCase().regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, '规则必须是域名，例如 github.com 或 *.github.com');
const folderInput = z.object({ name: z.string().trim().min(1).max(120), autoRules: z.array(autoRule).max(50).default([]) }).strict();
const appearanceOverride = z.object({ accentColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), cardColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), icon:z.string().trim().max(8).optional() }).strict();
const settings = z.object({ theme:z.enum(['system','light','dark']).optional(), layout:z.enum(['grid','list']).optional(), columnMode:z.enum(['auto','fixed']).optional(), columns:z.number().int().min(1).max(12).optional(), gap:z.number().min(0).max(96).optional(), cardWidth:z.number().min(120).max(800).optional(), centered:z.boolean().optional(), showAddButton:z.boolean().optional(), compact:z.boolean().optional(), fontFamily:z.string().max(200).optional(), textColor:z.string().max(100).nullable().optional(), accentColor:z.string().max(100).nullable().optional(), showDescription:z.boolean().optional(), showClickCount:z.boolean().optional(), showLastVisited:z.boolean().optional(), showRecommendations:z.boolean().optional() }).strict();
const uuidParams = z.object({ id });
const browserHistoryRecord = z.object({ url:z.string().url().max(4096), title:z.string().max(10_000).nullable(), lastVisitTime:z.number().int().nonnegative(), visitCount:z.number().int().nonnegative(), source:z.enum(['initial','live']) }).strict();
const browserHistoryRemoval = z.object({ allHistory:z.boolean(), urls:z.array(z.string().url().max(4096)).max(500).optional() }).strict();
const aiLinkInput = z.object({
  url: linkUrl,
  title: nullableText.optional(),
  description: nullableText.optional(),
  displayName: nullableText.optional(),
  appearanceOverride: appearanceOverride.nullable().optional(),
  folderId: id.optional(),
  folderName: z.string().trim().min(1).max(120).optional(),
}).strict().refine(value => !(value.folderId && value.folderName), 'folderId and folderName cannot both be provided');
const aiIngestInput = z.object({
  links: z.array(aiLinkInput).min(1).max(100),
  defaultFolderName: z.string().trim().min(1).max(120).default('收集箱'),
  createMissingFolders: z.boolean().default(true),
  onDuplicate: z.enum(['skip', 'update', 'create']).default('skip'),
}).strict();
const exportedLink = z.object({
  url: linkUrl,
  title: nullableText.optional(),
  description: nullableText.optional(),
  displayName: nullableText.optional(),
  appearanceOverride: appearanceOverride.nullable().optional(),
}).strict();
const exportedFolder = z.object({ name: z.string().trim().min(1).max(120), autoRules: z.array(autoRule).max(50).default([]), systemRole: z.enum(['inbox']).optional(), links: z.array(exportedLink).max(10_000) }).strict();
const exportBundle = z.object({
  format: z.literal('local-speed-dial/bookmarks'),
  version: z.literal(1),
  scope: z.enum(['library', 'folder']),
  exportedAt: z.string().datetime(),
  settings: settings.optional(),
  folders: z.array(exportedFolder).max(1_000),
}).strict().superRefine((value, context) => {
  if (value.scope === 'folder' && value.folders.length !== 1) context.addIssue({ code: 'custom', message: 'A folder export must contain exactly one folder', path: ['folders'] });
  if (value.scope === 'library' && value.settings === undefined) context.addIssue({ code: 'custom', message: 'A library export must include settings', path: ['settings'] });
});
const importInput = z.object({
  bundle: exportBundle,
  onDuplicate: z.enum(['skip', 'update', 'create']).default('skip'),
  createMissingFolders: z.boolean().default(true),
  targetFolderId: id.optional(),
  includeSettings: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.targetFolderId && value.bundle.scope !== 'folder') context.addIssue({ code: 'custom', message: 'targetFolderId can only be used with a folder export', path: ['targetFolderId'] });
});
const browserHistoryList = z.object({ query:z.string().trim().max(200).optional(), cursorTime:z.coerce.number().int().nonnegative().optional(), cursorUrl:z.string().url().max(4096).optional(), limit:z.coerce.number().int().min(1).max(100).default(50) }).strict().refine(value => (value.cursorTime !== undefined) === (value.cursorUrl !== undefined), 'cursorTime and cursorUrl must be provided together');
function parse<T>(schema: z.ZodType<T>, value: unknown): T { return schema.parse(value); }
function exportFolder(store: Store, folder: { name: string; autoRules: string[]; systemRole: 'inbox' | null; id: string }) {
  return {
    name: folder.name,
    autoRules: folder.autoRules,
    ...(folder.systemRole ? { systemRole: folder.systemRole } : {}),
    links: store.listLinks(folder.id).map(({ url, title, description, displayName, appearanceOverride }) => ({ url, title, description, displayName, appearanceOverride })),
  };
}
function importLinks(store: Store, input: z.infer<typeof importInput>) {
  const created: unknown[] = [], updated: unknown[] = [], skipped: Array<{ url: string; linkId: string }> = [], foldersCreated: unknown[] = [];
  const targetFolder = input.targetFolderId ? store.getFolder(input.targetFolderId) : undefined;
  if (input.targetFolderId && !targetFolder) throw new Error(`Unknown folder: ${input.targetFolderId}`);
  for (const sourceFolder of input.bundle.folders) {
    let folder = targetFolder;
    if (!folder && sourceFolder.systemRole === 'inbox') {
      const existingInbox = store.listFolders().find(item => item.systemRole === 'inbox');
      folder = store.ensureInboxFolder(sourceFolder.name);
      if (!existingInbox) foldersCreated.push(folder);
    }
    if (!folder) folder = store.findFolderByName(sourceFolder.name);
    if (!folder) {
      if (!input.createMissingFolders) throw new Error(`Folder not found: ${sourceFolder.name}`);
      folder = store.createFolder(sourceFolder.name, sourceFolder.autoRules);
      foldersCreated.push(folder);
    }
    for (const sourceLink of sourceFolder.links) {
      const duplicate = store.findLinksByUrl(sourceLink.url)[0];
      if (duplicate && input.onDuplicate === 'skip') { skipped.push({ url: sourceLink.url, linkId: duplicate.id }); continue; }
      if (duplicate && input.onDuplicate === 'update') {
        const fields = Object.fromEntries(Object.entries({ title: sourceLink.title, description: sourceLink.description, displayName: sourceLink.displayName, appearanceOverride: sourceLink.appearanceOverride }).filter(([, value]) => value !== undefined));
        const link = store.updateLink(duplicate.id, fields);
        updated.push(link && link.folderId !== folder.id ? store.moveLinkToFolder(link.id, folder.id) : link!);
        continue;
      }
      const link = store.createLink(folder.id, sourceLink);
      if (!link) throw new Error('Failed to create link');
      created.push(link);
      if (/^https?:\/\//i.test(link.url)) refreshMetadata(store, link.id, link.url);
      else store.setMetadata(link.id, { status: 'succeeded', error: null });
    }
  }
  const settingsUpdated = input.bundle.scope === 'library' && input.includeSettings ? store.setSettings(input.bundle.settings!) : null;
  return { created, updated, skipped, foldersCreated, settingsUpdated };
}
function refreshMetadata(store: Store, linkId: string, linkUrl: string) {
  void fetchMetadata(linkUrl)
    .then(metadata => { store.setMetadata(linkId, { ...metadata, status: 'succeeded', error: null }); })
    .catch(error => {
      const message = error instanceof MetadataError ? error.message : 'Metadata request failed';
      store.setMetadata(linkId, { status: 'failed', error: message });
    });
}

export interface ServerOptions { store: Store; token?: string; }
export function createServer({ store, token }: ServerOptions) {
  const app=Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Vary', 'Origin');
    const origin=request.headers.origin;
    if (origin?.startsWith('chrome-extension://')) reply.header('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') { reply.header('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS').header('Access-Control-Allow-Headers','authorization,content-type').code(204).send(); return reply; }
    if (request.url === '/health') return;
    if (token && request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: { code:'unauthorized', message:'A valid bearer token is required' } });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error:{ code:'invalid_request', message:'Invalid request', details:error.issues } });
    app.log.error({ err: error }, 'Local Speed Dial API request failed');
    return reply.code(500).send({ error:{ code:'internal_error', message: error instanceof Error ? error.message : 'Unexpected server error' } });
  });
  const notFound = (reply: { code: (n:number)=>{send:(value: unknown)=>unknown} }) => reply.code(404).send({ error:{ code:'not_found', message:'Resource not found' } });
  app.get('/health', async () => ({ status:'ok', protocolVersion:1 }));
  app.get('/api/settings', async () => store.getSettings());
  app.put('/api/settings', async request => store.setSettings(parse(settings, request.body)));
  app.get('/api/folders', async () => store.listFolders());
  app.get('/api/export', async () => {
    const { updatedAt: _updatedAt, ...exportedSettings } = store.getSettings();
    return { format: 'local-speed-dial/bookmarks', version: 1, scope: 'library', exportedAt: new Date().toISOString(), settings: exportedSettings, folders: store.listFolders().map(folder => exportFolder(store, folder)) };
  });
  app.post('/api/folders', async (request, reply) => { const body=parse(folderInput,request.body); return reply.code(201).send(store.createFolder(body.name, body.autoRules)); });
  app.patch('/api/folders/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); const body=parse(folderInput,request.body); const folder=store.getFolder(id); if (folder?.systemRole === 'inbox' && body.autoRules.length) return reply.code(400).send({ error:{ code:'invalid_request', message:'收集箱不能设置自动归集规则' } }); const result=store.updateFolder(id,body); return result ? { ...result.folder, autoCollected: result.moved } : notFound(reply); });
  app.delete('/api/folders/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); const folder=store.getFolder(id); if (folder?.systemRole === 'inbox') return reply.code(409).send({ error:{ code:'system_folder', message:'收集箱不能删除' } }); return store.deleteFolder(id) ? reply.code(204).send() : notFound(reply); });
  app.post('/api/folders/reorder', async request => store.reorderFolders(parse(z.object({ids:z.array(id)}),request.body).ids));
  app.get('/api/folders/:id/export', async (request, reply) => { const { id } = parse(uuidParams, request.params); const folder = store.getFolder(id); return folder ? { format: 'local-speed-dial/bookmarks', version: 1, scope: 'folder', exportedAt: new Date().toISOString(), folders: [exportFolder(store, folder)] } : notFound(reply); });
  app.get('/api/folders/:folderId/links', async (request,reply) => { const {folderId}=parse(z.object({folderId:id}),request.params); return store.getFolder(folderId) ? store.listLinks(folderId) : notFound(reply); });
  app.get('/api/links/duplicates', async request => { const { url } = parse(z.object({ url: linkUrl }), request.query); return store.findLinksByUrl(url); });
  app.get('/api/recommendations', async () => ({ recommendations: store.listRecommendations() }));
  app.post('/api/capture', async (request, reply) => {
    const body = parse(z.object({ url:linkUrl, title:nullableText.optional() }).strict(), request.body);
    const inbox = store.ensureInboxFolder();
    const duplicate = store.findLinksByUrl(body.url)[0];
    if (duplicate) return { status:'already-saved', link:duplicate, inbox };
    const link = store.createLink(inbox.id, body, { applyAutoRules:false });
    if (!link) throw new Error('Failed to capture link');
    if (/^https?:\/\//i.test(link.url)) refreshMetadata(store, link.id, link.url);
    else store.setMetadata(link.id, { status:'succeeded', error:null });
    return reply.code(201).send({ status:'created', link, inbox });
  });
  app.post('/api/ai/links', async (request, reply) => {
    const body = parse(aiIngestInput, request.body);
    const created: unknown[] = [], updated: unknown[] = [], skipped: Array<{ url: string; linkId: string }> = [], foldersCreated: unknown[] = [];
    const foldersByName = new Map<string, string>();
    const resolveFolder = (item: z.infer<typeof aiLinkInput>) => {
      if (item.folderId) {
        if (!store.getFolder(item.folderId)) throw new Error(`Unknown folder: ${item.folderId}`);
        return item.folderId;
      }
      const name = item.folderName ?? body.defaultFolderName;
      const key = name.toLocaleLowerCase();
      const known = foldersByName.get(key);
      if (known) return known;
      const existing = store.findFolderByName(name);
      if (existing) { foldersByName.set(key, existing.id); return existing.id; }
      if (!body.createMissingFolders) throw new Error(`Folder not found: ${name}`);
      const folder = store.createFolder(name);
      foldersByName.set(key, folder.id);
      foldersCreated.push(folder);
      return folder.id;
    };
    for (const item of body.links) {
      const folderId = resolveFolder(item);
      const duplicate = store.findLinksByUrl(item.url)[0];
      if (duplicate && body.onDuplicate === 'skip') { skipped.push({ url: item.url, linkId: duplicate.id }); continue; }
      if (duplicate && body.onDuplicate === 'update') {
        const fields = Object.fromEntries(Object.entries({ title: item.title, description: item.description, displayName: item.displayName, appearanceOverride: item.appearanceOverride }).filter(([, value]) => value !== undefined));
        const link = store.updateLink(duplicate.id, fields);
        const moved = link && link.folderId !== folderId ? store.moveLinkToFolder(link.id, folderId) : link;
        updated.push(moved!);
        continue;
      }
      const link = store.createLink(folderId, item);
      if (!link) throw new Error('Failed to create link');
      created.push(link);
      if (/^https?:\/\//i.test(link.url)) refreshMetadata(store, link.id, link.url);
      else store.setMetadata(link.id, { status: 'succeeded', error: null });
    }
    return reply.code(201).send({ created, updated, skipped, foldersCreated });
  });
  app.post('/api/import', async (request, reply) => reply.code(201).send(importLinks(store, parse(importInput, request.body))));
  app.post('/api/history/records', async request => store.recordBrowserHistory(parse(z.object({ records:z.array(browserHistoryRecord).min(1).max(100) }).strict(), request.body).records));
  app.post('/api/history/removals', async request => store.markBrowserHistoryRemoved(parse(browserHistoryRemoval, request.body)));
  app.get('/api/history', async request => { const query = parse(browserHistoryList, request.query); return store.listBrowserHistory({ query: query.query, cursor: query.cursorTime === undefined ? undefined : { time: query.cursorTime, url: query.cursorUrl! }, limit: query.limit }); });
  app.post('/api/folders/:folderId/links', async (request,reply) => {
    const {folderId}=parse(z.object({folderId:id}),request.params);
    const body=parse(z.object({ url: linkUrl, title: nullableText.optional(), description: nullableText.optional(), displayName: nullableText.optional(), appearanceOverride:appearanceOverride.nullable().optional() }).strict(),request.body);
    const link=store.createLink(folderId,body);
    if (!link) return notFound(reply);
    if (/^https?:\/\//i.test(link.url)) {
      // Metadata is best-effort: return the persisted pending link immediately.
      refreshMetadata(store, link.id, link.url);
      return reply.code(201).send(link);
    }
    return reply.code(201).send(store.setMetadata(link.id, { status: 'succeeded', error: null }));
  });
  app.patch('/api/links/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); const body=parse(z.object({url:linkUrl.optional(),title:nullableText.optional(),description:nullableText.optional(),faviconUrl:httpUrl.nullable().optional(),displayName:nullableText.optional(),appearanceOverride:appearanceOverride.nullable().optional()}).strict(),request.body); const link=store.updateLink(id,body); return link ?? notFound(reply); });
  app.delete('/api/links/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); return store.deleteLink(id) ? reply.code(204).send() : notFound(reply); });
  app.post('/api/links/move', async request => { const body=parse(z.object({ ids:z.array(id).min(1).max(1_000), folderId:id }).strict(),request.body); return { moved:store.moveLinksToFolder(body.ids,body.folderId) }; });
  app.post('/api/links/reorder', async request => { const body=parse(z.object({items:z.array(z.object({id,folderId:id})).min(1)}),request.body); store.reorderLinks(body.items); return { ok:true }; });
  app.post('/api/links/:id/clicks', async (request,reply) => { const {id}=parse(uuidParams,request.params); const link=store.recordClick(id); return link ?? notFound(reply); });
  app.post('/api/links/:id/refresh-metadata', async (request,reply) => { const {id}=parse(uuidParams,request.params); const link=store.getLink(id); if (!link) return notFound(reply); try { const metadata=await fetchMetadata(link.url); return store.setMetadata(id,{...metadata,status:'succeeded',error:null}); } catch (error) { const message=error instanceof MetadataError ? error.message : 'Metadata request failed'; return store.setMetadata(id,{status:'failed',error:message}); } });
  return app;
}
