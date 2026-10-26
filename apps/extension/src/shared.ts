import type { Link, Folder } from './types';
export const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
export const displayTitle = (link: Link) => link.displayName || link.title || new URL(link.url).hostname;
export const displayHost = (url: string) => { try { return new URL(url).hostname || new URL(url).protocol.replace(':', ''); } catch { return url; } };
export const normalizeLinkUrl = (value: string) => {
  const url = value.trim();
  return url && !/^[a-z][a-z\d+.-]*:/i.test(url) ? `https://${url}` : url;
};
export function folderSubtreeIds(folders: Folder[], rootId: string) {
  const children = new Map<string, string[]>(); for (const folder of folders) { if (!folder.parentId) continue; const ids = children.get(folder.parentId) ?? []; ids.push(folder.id); children.set(folder.parentId, ids); }
  const result: string[] = []; const queue = [rootId]; const seen = new Set<string>();
  while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); result.push(id); queue.push(...(children.get(id) ?? [])); }
  return result;
}


export const LINK_TREE_DRAG_TYPE = 'application/x-local-speed-dial-link-ids';
