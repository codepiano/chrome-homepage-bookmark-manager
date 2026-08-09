import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class MetadataError extends Error {}
export interface PageMetadata { title: string | null; description: string | null; faviconUrl: string | null; }

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FAVICON_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const HEAD_END = /<\/head\s*>/i;

function mappedIpv4(ip: string): string | null {
  const tailStart = ip.lastIndexOf(':');
  const tail = ip.slice(tailStart + 1);
  const dottedTail = net.isIP(tail) === 4 ? tail.split('.').map(Number) : null;
  const normalizedIp = dottedTail
    ? `${ip.slice(0, tailStart + 1)}${((dottedTail[0] << 8) | dottedTail[1]).toString(16)}:${((dottedTail[2] << 8) | dottedTail[3]).toString(16)}`
    : ip;
  const halves = normalizedIp.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => part ? part.split(':').map(value => {
    if (!/^[0-9a-f]{1,4}$/.test(value)) return null;
    return Number.parseInt(value, 16);
  }) : [];
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? '');
  if ([...left, ...right].some(value => value === null)) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  if (groups.length !== 8 || groups.slice(0, 5).some(value => value !== 0) || groups[5] !== 0xffff) return null;
  return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

export function blockedIp(ip: string) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const mapped = mappedIpv4(ip);
  if (mapped) return blockedIp(mapped);
  const normalized = ip.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd');
}
async function assertPublicTarget(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new MetadataError('Only HTTP(S) URLs can be fetched');
  if (url.username || url.password) throw new MetadataError('Credentialed URLs cannot be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (blockedIp(host)) throw new MetadataError('Private or loopback addresses cannot be fetched'); return; }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(address => blockedIp(address.address))) throw new MetadataError('Target resolves to a private or loopback address');
}
function text(value: string | undefined) { return value?.replace(/\s+/g, ' ').trim() || null; }
function decode(value: string) { return value.replace(/&quot;|&#34;/gi, '"').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'); }
function attr(html: string, matcher: RegExp) { const match=matcher.exec(html); return match?.[1] ? text(decode(match[1])) : null; }
function absolute(raw: string | null, base: URL) { try { return raw ? new URL(raw, base).toString() : null; } catch { return null; } }
function tagAttribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match?.[2] ? text(decode(match[2])) : null;
}
function matchingMeta(html: string, names: string[]) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tagAttribute(tag, 'name')?.toLowerCase() ?? tagAttribute(tag, 'property')?.toLowerCase();
    if (name && names.includes(name)) return tagAttribute(tag, 'content');
  }
  return null;
}
function faviconFrom(html: string, finalUrl: URL) {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rel = tagAttribute(tag, 'rel')?.toLowerCase();
    if (rel && /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/.test(rel)) return absolute(tagAttribute(tag, 'href'), finalUrl);
  }
  return null;
}
export function parseMetadata(html: string, finalUrl: URL): PageMetadata {
  const title = matchingMeta(html, ['og:title', 'twitter:title']) ?? attr(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchingMeta(html, ['description', 'og:description', 'twitter:description']);
  const favicon = faviconFrom(html, finalUrl) ?? new URL('/favicon.ico', finalUrl).toString();
  return { title, description, faviconUrl: favicon };
}

/** Reads only the document head: metadata never needs the potentially huge body. */
export async function readMetadataHtml(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let html = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return html + decoder.decode();
    size += value.byteLength;
    html += decoder.decode(value, { stream: true });
    const headEnd = html.search(HEAD_END);
    if (headEnd >= 0) {
      const match = html.slice(headEnd).match(HEAD_END)?.[0] ?? '';
      await reader.cancel();
      return html.slice(0, headEnd + match.length);
    }
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new MetadataError('Page head is too large');
    }
  }
}

async function readLimitedBytes(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function inlineFavicon(faviconUrl: string | null, pageUrl: URL) {
  if (!faviconUrl) return null;
  let url: URL;
  try { url = new URL(faviconUrl); } catch { return faviconUrl; }
  try {
    for (let redirects = 0; redirects <= 2; redirects++) {
      await assertPublicTarget(url);
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        referer: pageUrl.toString(),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 Local-Speed-Dial/1.0',
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return faviconUrl;
        url = new URL(location, url);
        continue;
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase();
      if (!response.ok || !contentType?.startsWith('image/') || !response.body) return faviconUrl;
      const bytes = await readLimitedBytes(response.body, MAX_FAVICON_BYTES);
      return bytes ? `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}` : faviconUrl;
    }
  } catch { /* A remote icon must not make page metadata fail. */ }
  return faviconUrl;
}

/** Fetches public HTML only. Every redirect target is DNS-checked before request. */
export async function fetchMetadata(input: string): Promise<PageMetadata> {
  let url: URL; try { url = new URL(input); } catch { throw new MetadataError('Invalid URL'); }
  for (let redirects=0; redirects <= 4; redirects++) {
    await assertPublicTarget(url);
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 Local-Speed-Dial/1.0',
      } });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new MetadataError('Page request timed out');
      throw new MetadataError('Page request could not be completed');
    }
    if ([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location'); if (!location) throw new MetadataError('Redirect has no location'); url=new URL(location,url); continue;
    }
    if (!response.ok) throw new MetadataError(`Page returned HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new MetadataError('Page is not HTML');
    if (!response.body) throw new MetadataError('Page has no body');
    const metadata = parseMetadata(await readMetadataHtml(response.body), url);
    return { ...metadata, faviconUrl: await inlineFavicon(metadata.faviconUrl, url) };
  }
  throw new MetadataError('Too many redirects');
}
