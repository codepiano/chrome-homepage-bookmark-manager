export type MetadataStatus = 'pending' | 'succeeded' | 'failed';
export interface LinkAppearance { accentColor?: string; cardColor?: string; icon?: string; }

export interface Folder {
  id: string;
  name: string;
  autoRules: string[];
  position: number;
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
  appearanceOverride: LinkAppearance | null;
  position: number;
  clickCount: number;
  lastClickedAt: string | null;
}

export interface BrowserHistoryPage {
  url: string;
  title: string | null;
  lastVisitTime: number;
  visitCount: number;
  chromeRemovedAt: string | null;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  layout: 'grid' | 'list';
  columns: number;
  gap: number;
  cardWidth: number;
  centered: boolean;
  showAddButton: boolean;
  compact: boolean;
  fontFamily: string;
  textColor: string | null;
  accentColor: string;
  showDescription: boolean;
  showClickCount: boolean;
  showLastVisited: boolean;
}

export const defaultSettings: Settings = {
  theme: 'system', layout: 'grid', columns: 4, gap: 14, cardWidth: 230,
  centered: false, showAddButton: true, compact: false, fontFamily: 'system-ui',
  textColor: null, accentColor: '#4f46e5', showDescription: true,
  showClickCount: true, showLastVisited: true,
};

export type LinkDraft = Pick<Link, 'url' | 'title' | 'description' | 'faviconUrl' | 'displayName' | 'appearanceOverride'>;
