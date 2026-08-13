import { describe, expect, it } from 'vitest';
import { buildSmartViews } from './smartViews';
import type { Link } from './types';

const now = Date.parse('2026-08-13T00:00:00.000Z');
const link = (id: string, overrides: Partial<Link> = {}): Link => ({
  id,
  folderId: 'folder-1',
  url: `https://example.com/${id}`,
  title: id,
  description: null,
  faviconUrl: null,
  displayName: null,
  metadataStatus: 'succeeded',
  metadataError: null,
  appearanceOverride: null,
  position: 0,
  clickCount: 0,
  lastClickedAt: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  ...overrides,
});

describe('buildSmartViews', () => {
  it('uses creation time for recent links and unvisited stale links', () => {
    const views = buildSmartViews([
      link('new'),
      link('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      link('visited-old', { createdAt: '2025-01-01T00:00:00.000Z', lastClickedAt: '2026-08-01T00:00:00.000Z' }),
    ], now);

    expect(views.find((view) => view.id === 'recent')?.links.map(({ id }) => id)).toEqual(['new']);
    expect(views.find((view) => view.id === 'stale')?.links.map(({ id }) => id)).toEqual(['old']);
  });

  it('collects failed metadata and every member of exact duplicate groups', () => {
    const views = buildSmartViews([
      link('failed', { metadataStatus: 'failed' }),
      link('copy-a', { url: 'https://example.com/same' }),
      link('copy-b', { folderId: 'folder-2', url: 'https://example.com/same' }),
      link('different', { url: 'https://example.com/same/' }),
    ], now);

    expect(views.find((view) => view.id === 'metadataFailed')?.links.map(({ id }) => id)).toEqual(['failed']);
    expect(views.find((view) => view.id === 'duplicates')?.links.map(({ id }) => id)).toEqual(['copy-a', 'copy-b']);
  });
});
