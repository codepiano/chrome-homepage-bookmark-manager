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
const settings = z.object({ theme:z.enum(['system','light','dark']).optional(), layout:z.enum(['grid','list']).optional(), columns:z.number().int().min(1).max(12).optional(), gap:z.number().min(0).max(96).optional(), cardWidth:z.number().min(120).max(800).optional(), centered:z.boolean().optional(), showAddButton:z.boolean().optional(), compact:z.boolean().optional(), fontFamily:z.string().max(200).optional(), textColor:z.string().max(100).nullable().optional(), accentColor:z.string().max(100).nullable().optional(), showDescription:z.boolean().optional(), showClickCount:z.boolean().optional(), showLastVisited:z.boolean().optional() }).strict();
const uuidParams = z.object({ id });
function parse<T>(schema: z.ZodType<T>, value: unknown): T { return schema.parse(value); }
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
  const app=Fastify({ logger: true, bodyLimit: 64 * 1024 });
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
  app.post('/api/folders', async (request, reply) => { const body=parse(z.object({ name:z.string().trim().min(1).max(120) }),request.body); return reply.code(201).send(store.createFolder(body.name)); });
  app.patch('/api/folders/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); const body=parse(z.object({name:z.string().trim().min(1).max(120)}),request.body); const folder=store.updateFolder(id,body.name); return folder ?? notFound(reply); });
  app.delete('/api/folders/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); return store.deleteFolder(id) ? reply.code(204).send() : notFound(reply); });
  app.post('/api/folders/reorder', async request => store.reorderFolders(parse(z.object({ids:z.array(id)}),request.body).ids));
  app.get('/api/folders/:folderId/links', async (request,reply) => { const {folderId}=parse(z.object({folderId:id}),request.params); return store.getFolder(folderId) ? store.listLinks(folderId) : notFound(reply); });
  app.post('/api/folders/:folderId/links', async (request,reply) => {
    const {folderId}=parse(z.object({folderId:id}),request.params);
    const body=parse(z.object({ url: linkUrl, title: nullableText.optional(), description: nullableText.optional(), displayName: nullableText.optional() }).strict(),request.body);
    const link=store.createLink(folderId,body);
    if (!link) return notFound(reply);
    if (/^https?:\/\//i.test(link.url)) {
      // Metadata is best-effort: return the persisted pending link immediately.
      refreshMetadata(store, link.id, link.url);
      return reply.code(201).send(link);
    }
    return reply.code(201).send(store.setMetadata(link.id, { status: 'succeeded', error: null }));
  });
  app.patch('/api/links/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); const body=parse(z.object({url:linkUrl.optional(),title:nullableText.optional(),description:nullableText.optional(),faviconUrl:httpUrl.nullable().optional(),displayName:nullableText.optional(),appearanceOverride:z.record(z.string(),z.unknown()).nullable().optional()}).strict(),request.body); const link=store.updateLink(id,body); return link ?? notFound(reply); });
  app.delete('/api/links/:id', async (request,reply) => { const {id}=parse(uuidParams,request.params); return store.deleteLink(id) ? reply.code(204).send() : notFound(reply); });
  app.post('/api/links/reorder', async request => { const body=parse(z.object({items:z.array(z.object({id,folderId:id})).min(1)}),request.body); store.reorderLinks(body.items); return { ok:true }; });
  app.post('/api/links/:id/clicks', async (request,reply) => { const {id}=parse(uuidParams,request.params); const link=store.recordClick(id); return link ?? notFound(reply); });
  app.post('/api/links/:id/refresh-metadata', async (request,reply) => { const {id}=parse(uuidParams,request.params); const link=store.getLink(id); if (!link) return notFound(reply); try { const metadata=await fetchMetadata(link.url); return store.setMetadata(id,{...metadata,status:'succeeded',error:null}); } catch (error) { const message=error instanceof MetadataError ? error.message : 'Metadata request failed'; return store.setMetadata(id,{status:'failed',error:message}); } });
  return app;
}
