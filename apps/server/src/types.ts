export type MetadataStatus = 'pending' | 'succeeded' | 'failed';

export interface Folder {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  linkCount?: number;
}

export interface Link {
  id: string;
  folderId: string;
  url: string;
  title: string | null;
  description: string | null;
  faviconUrl: string | null;
  displayName: string | null;
  metadataStatus: MetadataStatus;
  metadataError: string | null;
  metadataFetchedAt: string | null;
  appearanceOverride: Record<string, unknown> | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  clickCount: number;
  lastClickedAt: string | null;
}

export const DEFAULT_SETTINGS = {
  theme: 'system', layout: 'grid', columns: 4, gap: 16, cardWidth: 240,
  centered: true, showAddButton: true, compact: false, fontFamily: 'system-ui',
  textColor: null, accentColor: '#4f46e5', showDescription: true,
  showClickCount: true, showLastVisited: true,
};
