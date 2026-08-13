import type { Link } from './types';

export type SmartViewId = 'recent' | 'stale' | 'metadataFailed' | 'duplicates';

export interface SmartView {
  id: SmartViewId;
  label: string;
  description: string;
  emptyMessage: string;
  links: Link[];
}

const day = 24 * 60 * 60 * 1000;
export const recentWindowDays = 14;
export const staleWindowDays = 90;

const timestamp = (value: string | null) => value ? Date.parse(value) : Number.NaN;

export function buildSmartViews(links: Link[], now = Date.now()): SmartView[] {
  const recentCutoff = now - recentWindowDays * day;
  const staleCutoff = now - staleWindowDays * day;
  const duplicateUrls = new Set(
    [...links.reduce((groups, link) => groups.set(link.url, (groups.get(link.url) ?? 0) + 1), new Map<string, number>())]
      .filter(([, count]) => count > 1)
      .map(([url]) => url),
  );

  return [
    {
      id: 'recent',
      label: '最近添加',
      description: `近 ${recentWindowDays} 天添加 · 新内容优先`,
      emptyMessage: `近 ${recentWindowDays} 天还没有添加新链接。`,
      links: links.filter((link) => timestamp(link.createdAt) >= recentCutoff).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)),
    },
    {
      id: 'stale',
      label: '久未访问',
      description: `超过 ${staleWindowDays} 天未打开 · 最久未访问优先`,
      emptyMessage: `没有超过 ${staleWindowDays} 天未访问的链接。`,
      links: links.filter((link) => timestamp(link.lastClickedAt ?? link.createdAt) < staleCutoff).sort((a, b) => timestamp(a.lastClickedAt ?? a.createdAt) - timestamp(b.lastClickedAt ?? b.createdAt)),
    },
    {
      id: 'metadataFailed',
      label: '信息待修复',
      description: '网页信息获取失败 · 可逐项重新抓取',
      emptyMessage: '所有链接的网页信息都处于正常状态。',
      links: links.filter((link) => link.metadataStatus === 'failed').sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)),
    },
    {
      id: 'duplicates',
      label: '重复链接',
      description: '相同网址存在多份 · 可编辑或删除多余条目',
      emptyMessage: '没有发现网址完全相同的重复链接。',
      links: links.filter((link) => duplicateUrls.has(link.url)).sort((a, b) => a.url.localeCompare(b.url) || timestamp(a.createdAt) - timestamp(b.createdAt)),
    },
  ];
}
