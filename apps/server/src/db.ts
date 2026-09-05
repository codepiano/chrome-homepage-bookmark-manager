import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserHistoryPage, BrowserHistoryRecord, Folder, Link, LinkAppearance, LinkHealthStatus, MetadataStatus } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

type SqlRow = Record<string, unknown>;
const now = () => new Date().toISOString();

function folderFrom(row: SqlRow): Folder {
  return { id: String(row.id), name: String(row.name), parentId: row.parent_id == null ? null : String(row.parent_id), autoRules: jsonStringArray(row.auto_rules_json), systemRole: row.system_role === 'inbox' ? 'inbox' : null, position: Number(row.position), createdAt: String(row.created_at), updatedAt: String(row.updated_at), linkCount: Number(row.link_count ?? 0) };
}
function jsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try { const result: unknown = JSON.parse(value); return Array.isArray(result) && result.every(item => typeof item === 'string') ? result : []; } catch { return []; }
}
function jsonObject(value: unknown): LinkAppearance | null {
  if (typeof value !== 'string' || !value) return null;
  try { const result: unknown = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result as LinkAppearance : null; } catch { return null; }
}
function linkFrom(row: SqlRow): Link {
  return {
    id: String(row.id), folderId: String(row.folder_id), url: String(row.url), title: row.title as string | null,
    description: row.description as string | null, faviconUrl: row.favicon_url as string | null,
    displayName: row.display_name as string | null, metadataStatus: row.metadata_status as MetadataStatus,
    metadataError: row.metadata_error as string | null, metadataFetchedAt: row.metadata_fetched_at as string | null,
    appearanceOverride: jsonObject(row.appearance_override_json), position: Number(row.position),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), clickCount: Number(row.click_count ?? 0),
    lastClickedAt: row.last_clicked_at as string | null,
    healthStatus: (row.health_status as LinkHealthStatus | undefined) ?? 'unchecked', healthCheckedAt: row.health_checked_at as string | null,
    healthHttpStatus: row.health_http_status == null ? null : Number(row.health_http_status), healthRedirectUrl: row.health_redirect_url as string | null,
    healthError: row.health_error as string | null,
    pinnedAt: row.pinned_at as string | null,
  };
}
function historyPageFrom(row: SqlRow): BrowserHistoryPage {
  return { url: String(row.url), title: row.title as string | null, lastVisitTime: Number(row.last_visit_time), visitCount: Number(row.visit_count), chromeRemovedAt: row.chrome_removed_at as string | null };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL, auto_rules_json TEXT NOT NULL DEFAULT '[]', system_role TEXT CHECK(system_role IS NULL OR system_role = 'inbox'), position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT, description TEXT, favicon_url TEXT, display_name TEXT, metadata_status TEXT NOT NULL DEFAULT 'pending' CHECK(metadata_status IN ('pending','succeeded','failed')), metadata_error TEXT, metadata_fetched_at TEXT, appearance_override_json TEXT, position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_by_folder_id TEXT, health_status TEXT NOT NULL DEFAULT 'unchecked', health_checked_at TEXT, health_http_status INTEGER, health_redirect_url TEXT, health_error TEXT, pinned_at TEXT);
      CREATE INDEX IF NOT EXISTS links_folder_position ON links(folder_id, position, id);
      CREATE TABLE IF NOT EXISTS click_events (id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, clicked_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS click_events_link_time ON click_events(link_id, clicked_at DESC);
      CREATE TABLE IF NOT EXISTS link_merge_clicks (event_id TEXT PRIMARY KEY REFERENCES click_events(id) ON DELETE CASCADE, source_link_id TEXT NOT NULL, keep_link_id TEXT NOT NULL, merged_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_snapshots (id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('daily','manual','pre_restore')), snapshot_json TEXT NOT NULL, folder_count INTEGER NOT NULL, link_count INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS library_snapshots_created_at ON library_snapshots(created_at DESC);
      CREATE TABLE IF NOT EXISTS browser_history_pages (url TEXT PRIMARY KEY, title TEXT, last_visit_time INTEGER NOT NULL, visit_count INTEGER NOT NULL, first_synced_at TEXT NOT NULL, last_synced_at TEXT NOT NULL, chrome_removed_at TEXT);
      CREATE INDEX IF NOT EXISTS browser_history_pages_last_visit ON browser_history_pages(last_visit_time DESC);
      CREATE TABLE IF NOT EXISTS browser_history_events (id TEXT PRIMARY KEY, url TEXT NOT NULL REFERENCES browser_history_pages(url) ON DELETE CASCADE, visited_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('initial','live')), created_at TEXT NOT NULL, UNIQUE(url, visited_at));
      CREATE INDEX IF NOT EXISTS browser_history_events_visited_at ON browser_history_events(visited_at DESC);
      CREATE TABLE IF NOT EXISTS browser_history_hidden (url TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
    `);
    const folderColumns = this.db.prepare('PRAGMA table_info(folders)').all() as SqlRow[];
    if (!folderColumns.some(column => column.name === 'parent_id')) this.db.exec('ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL');
    if (!folderColumns.some(column => column.name === 'auto_rules_json')) this.db.exec("ALTER TABLE folders ADD COLUMN auto_rules_json TEXT NOT NULL DEFAULT '[]'");
    if (!folderColumns.some(column => column.name === 'system_role')) this.db.exec("ALTER TABLE folders ADD COLUMN system_role TEXT CHECK(system_role IS NULL OR system_role = 'inbox')");
    if (!folderColumns.some(column => column.name === 'deleted_at')) this.db.exec('ALTER TABLE folders ADD COLUMN deleted_at TEXT');
    const linkColumns = this.db.prepare('PRAGMA table_info(links)').all() as SqlRow[];
    if (!linkColumns.some(column => column.name === 'deleted_at')) this.db.exec('ALTER TABLE links ADD COLUMN deleted_at TEXT');
    if (!linkColumns.some(column => column.name === 'deleted_by_folder_id')) this.db.exec('ALTER TABLE links ADD COLUMN deleted_by_folder_id TEXT');
    if (!linkColumns.some(column => column.name === 'health_status')) this.db.exec("ALTER TABLE links ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unchecked'");
    if (!linkColumns.some(column => column.name === 'health_checked_at')) this.db.exec('ALTER TABLE links ADD COLUMN health_checked_at TEXT');
    if (!linkColumns.some(column => column.name === 'health_http_status')) this.db.exec('ALTER TABLE links ADD COLUMN health_http_status INTEGER');
    if (!linkColumns.some(column => column.name === 'health_redirect_url')) this.db.exec('ALTER TABLE links ADD COLUMN health_redirect_url TEXT');
    if (!linkColumns.some(column => column.name === 'health_error')) this.db.exec('ALTER TABLE links ADD COLUMN health_error TEXT');
    if (!linkColumns.some(column => column.name === 'pinned_at')) this.db.exec('ALTER TABLE links ADD COLUMN pinned_at TEXT');
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS folders_system_role ON folders(system_role) WHERE system_role IS NOT NULL");
    const existing = this.db.prepare('SELECT id FROM settings WHERE id = 1').get();
    if (!existing) this.db.prepare('INSERT INTO settings (id, value_json, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(DEFAULT_SETTINGS), now());
  }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  getSettings() { const row = this.db.prepare('SELECT value_json, updated_at FROM settings WHERE id=1').get() as SqlRow; return { ...DEFAULT_SETTINGS, ...jsonObject(row.value_json), updatedAt: row.updated_at }; }
  setSettings(value: Record<string, unknown>) { const current = this.getSettings(); const next = { ...current, ...value }; delete (next as Record<string, unknown>).updatedAt; const timestamp = now(); this.db.prepare('UPDATE settings SET value_json=?, updated_at=? WHERE id=1').run(JSON.stringify(next), timestamp); return { ...next, updatedAt: timestamp }; }
  createSnapshot(label = '手动快照', kind: 'daily' | 'manual' | 'pre_restore' = 'manual') {
    const folders=this.db.prepare("SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY COALESCE(parent_id,''),position,id").all() as SqlRow[];
    const links=this.db.prepare('SELECT * FROM links WHERE deleted_at IS NULL ORDER BY folder_id,position,id').all() as SqlRow[];
    const settings=this.db.prepare('SELECT value_json FROM settings WHERE id=1').get() as SqlRow; const id=randomUUID(), createdAt=now();
    this.db.prepare('INSERT INTO library_snapshots (id,label,kind,snapshot_json,folder_count,link_count,created_at) VALUES (?,?,?,?,?,?,?)').run(id,label,kind,JSON.stringify({folders,links,settings:settings.value_json}),folders.length,links.length,createdAt);
    const stale=this.db.prepare('SELECT id FROM library_snapshots ORDER BY created_at DESC LIMIT -1 OFFSET 30').all() as SqlRow[]; for(const row of stale)this.db.prepare('DELETE FROM library_snapshots WHERE id=?').run(String(row.id));
    return {id,label,kind,folderCount:folders.length,linkCount:links.length,createdAt};
  }
  ensureDailySnapshot() { const day=new Intl.DateTimeFormat('en-CA').format(new Date()); const existing=this.db.prepare("SELECT id FROM library_snapshots WHERE kind='daily' AND label=? LIMIT 1").get(day); return existing?null:this.createSnapshot(day,'daily'); }
  listSnapshots() { return (this.db.prepare('SELECT id,label,kind,folder_count,link_count,created_at FROM library_snapshots ORDER BY created_at DESC').all() as SqlRow[]).map(row=>({id:String(row.id),label:String(row.label),kind:String(row.kind),folderCount:Number(row.folder_count),linkCount:Number(row.link_count),createdAt:String(row.created_at)})); }
  restoreSnapshot(id: string) {
    const row=this.db.prepare('SELECT snapshot_json FROM library_snapshots WHERE id=?').get(id) as SqlRow|undefined; if(!row)return false;
    let snapshot:{folders:SqlRow[];links:SqlRow[];settings:string}; try{snapshot=JSON.parse(String(row.snapshot_json)) as typeof snapshot;}catch{throw new Error('Snapshot data is invalid');}
    if(!Array.isArray(snapshot.folders)||!Array.isArray(snapshot.links)||typeof snapshot.settings!=='string')throw new Error('Snapshot data is incomplete');
    this.createSnapshot('恢复前自动快照','pre_restore'); const timestamp=now();
    return this.transaction(()=>{
      this.db.prepare('UPDATE links SET deleted_at=?,deleted_by_folder_id=NULL,updated_at=? WHERE deleted_at IS NULL').run(timestamp,timestamp);
      this.db.prepare('UPDATE folders SET deleted_at=?,updated_at=? WHERE deleted_at IS NULL AND system_role IS NULL').run(timestamp,timestamp);
      const folderUpsert=this.db.prepare(`INSERT INTO folders (id,name,parent_id,auto_rules_json,system_role,position,created_at,updated_at,deleted_at) VALUES (?,?,NULL,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=NULL,auto_rules_json=excluded.auto_rules_json,system_role=excluded.system_role,position=excluded.position,created_at=excluded.created_at,updated_at=excluded.updated_at,deleted_at=NULL`);
      for(const folder of snapshot.folders)folderUpsert.run(String(folder.id),String(folder.name),String(folder.auto_rules_json??'[]'),folder.system_role==null?null:String(folder.system_role),Number(folder.position),String(folder.created_at),String(folder.updated_at));
      for(const folder of snapshot.folders)this.db.prepare('UPDATE folders SET parent_id=? WHERE id=?').run(folder.parent_id==null?null:String(folder.parent_id),String(folder.id));
      const linkUpsert=this.db.prepare(`INSERT INTO links (id,folder_id,url,title,description,favicon_url,display_name,metadata_status,metadata_error,metadata_fetched_at,appearance_override_json,position,created_at,updated_at,deleted_at,deleted_by_folder_id,health_status,health_checked_at,health_http_status,health_redirect_url,health_error,pinned_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,url=excluded.url,title=excluded.title,description=excluded.description,favicon_url=excluded.favicon_url,display_name=excluded.display_name,metadata_status=excluded.metadata_status,metadata_error=excluded.metadata_error,metadata_fetched_at=excluded.metadata_fetched_at,appearance_override_json=excluded.appearance_override_json,position=excluded.position,created_at=excluded.created_at,updated_at=excluded.updated_at,deleted_at=NULL,deleted_by_folder_id=NULL,health_status=excluded.health_status,health_checked_at=excluded.health_checked_at,health_http_status=excluded.health_http_status,health_redirect_url=excluded.health_redirect_url,health_error=excluded.health_error,pinned_at=excluded.pinned_at`);
      for(const link of snapshot.links)linkUpsert.run(String(link.id),String(link.folder_id),String(link.url),link.title==null?null:String(link.title),link.description==null?null:String(link.description),link.favicon_url==null?null:String(link.favicon_url),link.display_name==null?null:String(link.display_name),String(link.metadata_status??'pending'),link.metadata_error==null?null:String(link.metadata_error),link.metadata_fetched_at==null?null:String(link.metadata_fetched_at),link.appearance_override_json==null?null:String(link.appearance_override_json),Number(link.position),String(link.created_at),String(link.updated_at),String(link.health_status??'unchecked'),link.health_checked_at==null?null:String(link.health_checked_at),link.health_http_status==null?null:Number(link.health_http_status),link.health_redirect_url==null?null:String(link.health_redirect_url),link.health_error==null?null:String(link.health_error),link.pinned_at==null?null:String(link.pinned_at));
      this.db.prepare('UPDATE settings SET value_json=?,updated_at=? WHERE id=1').run(snapshot.settings,timestamp); return true;
    });
  }
  listFolders() { return (this.db.prepare("SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id AND l.deleted_at IS NULL WHERE f.deleted_at IS NULL GROUP BY f.id ORDER BY COALESCE(f.parent_id, ''), f.position, f.id").all() as SqlRow[]).map(folderFrom); }
  getFolder(id: string) { const row = this.db.prepare('SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id AND l.deleted_at IS NULL WHERE f.id=? AND f.deleted_at IS NULL GROUP BY f.id').get(id) as SqlRow | undefined; return row && folderFrom(row); }
  findFolderByName(name: string) { const row = this.db.prepare('SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id AND l.deleted_at IS NULL WHERE f.name=? COLLATE NOCASE AND f.deleted_at IS NULL GROUP BY f.id ORDER BY f.position, f.id LIMIT 1').get(name) as SqlRow | undefined; return row && folderFrom(row); }
  ensureInboxFolder(name = '收集箱') {
    const roleRow = this.db.prepare("SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id AND l.deleted_at IS NULL WHERE f.system_role='inbox' AND f.deleted_at IS NULL GROUP BY f.id LIMIT 1").get() as SqlRow | undefined;
    if (roleRow) return folderFrom(roleRow);
    const named = this.findFolderByName(name);
    if (named) {
      this.db.prepare("UPDATE folders SET system_role='inbox', auto_rules_json='[]', updated_at=? WHERE id=?").run(now(), named.id);
      return this.getFolder(named.id)!;
    }
    const timestamp = now(), id = randomUUID();
    const row = this.db.prepare('SELECT COALESCE(MIN(position), 0) AS min_position FROM folders').get() as SqlRow;
    this.db.prepare("INSERT INTO folders (id,name,parent_id,auto_rules_json,system_role,position,created_at,updated_at) VALUES (?, ?, NULL, '[]', 'inbox', ?, ?, ?)").run(id, name, Number(row.min_position) - 1, timestamp, timestamp);
    return this.getFolder(id)!;
  }
  private assertFolderParent(id: string | null, parentId: string | null) {
    if (!parentId) return;
    if (id && id === parentId) throw new Error('A folder cannot be its own parent');
    let cursor: string | null = parentId;
    while (cursor) {
      const row = this.db.prepare('SELECT parent_id FROM folders WHERE id=? AND deleted_at IS NULL').get(cursor) as SqlRow | undefined;
      if (!row) throw new Error('Unknown parent folder');
      if (id && cursor === id) throw new Error('A folder cannot be moved into its descendant');
      cursor = row.parent_id == null ? null : String(row.parent_id);
    }
  }
  createFolder(name: string, autoRules: string[] = [], parentId: string | null = null) { const timestamp = now(), id = randomUUID(); this.assertFolderParent(id, parentId); const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM folders WHERE parent_id IS ? AND deleted_at IS NULL').get(parentId) as SqlRow; this.db.prepare('INSERT INTO folders (id,name,parent_id,auto_rules_json,position,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, parentId, JSON.stringify(autoRules), Number(row.max_position) + 1, timestamp, timestamp); return this.getFolder(id)!; }
  updateFolder(id: string, fields: { name: string; autoRules: string[]; parentId?: string | null }) { const current = this.getFolder(id); if (!current) return null; const parentId = fields.parentId === undefined ? current.parentId : fields.parentId; this.assertFolderParent(id, parentId); const change = this.db.prepare('UPDATE folders SET name=?, parent_id=?, auto_rules_json=?, updated_at=? WHERE id=?').run(fields.name, parentId, JSON.stringify(fields.autoRules), now(), id); if (!change.changes) return null; const folder = this.getFolder(id)!; const moved = this.applyAutoRules(); return { folder, moved }; }
  deleteFolder(id: string) { const folder = this.getFolder(id); if (!folder || folder.systemRole === 'inbox') return false; const timestamp = now(); return this.transaction(() => { const rows = this.db.prepare('WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? AND deleted_at IS NULL UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.deleted_at IS NULL) SELECT id FROM subtree').all(id) as SqlRow[]; const ids = rows.map(row => String(row.id)); if (!ids.length) return false; const placeholders = ids.map(() => '?').join(','); this.db.prepare(`UPDATE links SET deleted_at=?, deleted_by_folder_id=?, updated_at=? WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL`).run(timestamp, id, timestamp, ...ids); this.db.prepare(`UPDATE folders SET deleted_at=?, updated_at=? WHERE id IN (${placeholders})`).run(timestamp, timestamp, ...ids); return true; }); }
  moveFolder(id: string, parentId: string | null, index: number) { return this.transaction(() => { const folder = this.getFolder(id); if (!folder || folder.systemRole === 'inbox') throw new Error('Folder cannot be moved'); this.assertFolderParent(id, parentId); const siblings = (this.db.prepare('SELECT id FROM folders WHERE parent_id IS ? AND id <> ? AND deleted_at IS NULL ORDER BY position, id').all(parentId, id) as SqlRow[]).map(row => String(row.id)); const target = Math.max(0, Math.min(index, siblings.length)); siblings.splice(target, 0, id); for (const [position, siblingId] of siblings.entries()) this.db.prepare('UPDATE folders SET parent_id=?, position=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(parentId, position, now(), siblingId); return this.getFolder(id)!; }); }
  reorderFolders(ids: string[]) { this.transaction(() => { const count = (this.db.prepare('SELECT COUNT(*) AS count FROM folders WHERE deleted_at IS NULL').get() as SqlRow).count; if (ids.length !== Number(count) || new Set(ids).size !== ids.length) throw new Error('Folder reorder must include every folder exactly once'); for (const [position, id] of ids.entries()) if (this.db.prepare('UPDATE folders SET parent_id=NULL, position=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(position, now(), id).changes !== 1) throw new Error('Unknown folder'); }); return this.listFolders(); }
  listLinks(folderId: string) { return (this.db.prepare(`SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l LEFT JOIN click_events c ON c.link_id=l.id WHERE l.folder_id=? AND l.deleted_at IS NULL GROUP BY l.id ORDER BY l.position, l.id`).all(folderId) as SqlRow[]).map(linkFrom); }
  findLinksByUrl(url: string) { return (this.db.prepare(`SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l LEFT JOIN click_events c ON c.link_id=l.id WHERE l.url=? AND l.deleted_at IS NULL GROUP BY l.id ORDER BY l.created_at DESC`).all(url) as SqlRow[]).map(linkFrom); }
  listRecommendations(limit = 8) {
    const base = `SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l JOIN click_events c ON c.link_id=l.id WHERE l.deleted_at IS NULL GROUP BY l.id`;
    const current = Date.now();
    return (this.db.prepare(base).all() as SqlRow[]).map(linkFrom).map(link => {
      const daysSinceLastVisit = link.lastClickedAt ? Math.max(0, (current - new Date(link.lastClickedAt).getTime()) / 86_400_000) : Infinity;
      const frequencyScore = Math.log2(link.clickCount + 1) * 60;
      const recencyScore = Number.isFinite(daysSinceLastVisit) ? 40 * Math.exp(-daysSinceLastVisit / 14) : 0;
      return { ...link, score: Math.round(frequencyScore + recencyScore) };
    }).sort((left, right) => right.score - left.score || right.clickCount - left.clickCount || String(right.lastClickedAt).localeCompare(String(left.lastClickedAt))).slice(0, limit);
  }
  getLink(id: string) { const row = this.db.prepare(`SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l LEFT JOIN click_events c ON c.link_id=l.id WHERE l.id=? AND l.deleted_at IS NULL GROUP BY l.id`).get(id) as SqlRow | undefined; return row && linkFrom(row); }
  private folderForUrl(url: string, fallbackFolderId: string) {
    let hostname: string;
    try { hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return fallbackFolderId; }
    return this.listFolders().find(folder => folder.autoRules.some(rule => rule.startsWith('*.') ? hostname === rule.slice(2) || hostname.endsWith(`.${rule.slice(2)}`) : hostname === rule))?.id ?? fallbackFolderId;
  }
  moveLinkToFolder(id: string, folderId: string) {
    if (!this.getFolder(folderId)) return null;
    const current = this.getLink(id);
    if (!current) return null;
    if (current.folderId === folderId) return current;
    const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM links WHERE folder_id=? AND deleted_at IS NULL').get(folderId) as SqlRow;
    this.db.prepare('UPDATE links SET folder_id=?, position=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(folderId, Number(max.max_position) + 1, now(), id);
    return this.getLink(id)!;
  }
  private applyAutoRules() { let moved = 0; for (const folder of this.listFolders()) { if (folder.systemRole === 'inbox') continue; for (const link of this.listLinks(folder.id)) { const target = this.folderForUrl(link.url, folder.id); if (target !== folder.id && this.moveLinkToFolder(link.id, target)) moved++; } } return moved; }
  createLink(folderId: string, fields: { url: string; title?: string | null; description?: string | null; displayName?: string | null; appearanceOverride?: LinkAppearance | null }, options: { applyAutoRules?: boolean } = {}) { const folder=this.getFolder(folderId); if (!folder) return null; const applyAutoRules = options.applyAutoRules ?? folder.systemRole !== 'inbox'; const targetFolderId = applyAutoRules ? this.folderForUrl(fields.url, folderId) : folderId; const timestamp=now(), id=randomUUID(); const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM links WHERE folder_id=? AND deleted_at IS NULL').get(targetFolderId) as SqlRow; this.db.prepare('INSERT INTO links (id,folder_id,url,title,description,display_name,appearance_override_json,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, targetFolderId, fields.url, fields.title ?? null, fields.description ?? null, fields.displayName ?? null, fields.appearanceOverride ? JSON.stringify(fields.appearanceOverride) : null, Number(max.max_position)+1, timestamp, timestamp); return this.getLink(id)!; }
  updateLink(id: string, fields: Record<string, unknown>) { const allowed: Record<string, string> = { url:'url', title:'title', description:'description', faviconUrl:'favicon_url', displayName:'display_name', appearanceOverride:'appearance_override_json' }; const values: Array<string | null>=[]; const changes: string[]=[]; for (const [key, column] of Object.entries(allowed)) if (key in fields) { changes.push(`${column}=?`); values.push(key === 'appearanceOverride' && fields[key] !== null ? JSON.stringify(fields[key]) : typeof fields[key] === 'string' ? fields[key] : null); } if (!changes.length) return this.getLink(id); values.push(now(), id); const result=this.db.prepare(`UPDATE links SET ${changes.join(', ')}, updated_at=? WHERE id=? AND deleted_at IS NULL`).run(...values); if (!result.changes) return null; const updated = this.getLink(id)!; const folder = this.getFolder(updated.folderId); if ('url' in fields && folder?.systemRole !== 'inbox') this.moveLinkToFolder(id, this.folderForUrl(updated.url, updated.folderId)); return this.getLink(id)!; }
  setMetadata(id: string, metadata: { title?: string | null; description?: string | null; faviconUrl?: string | null; status: MetadataStatus; error?: string | null }) { const result=this.db.prepare('UPDATE links SET title=COALESCE(?,title), description=COALESCE(?,description), favicon_url=COALESCE(?,favicon_url), metadata_status=?, metadata_error=?, metadata_fetched_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(metadata.title ?? null, metadata.description ?? null, metadata.faviconUrl ?? null, metadata.status, metadata.error ?? null, now(), now(), id); return result.changes ? this.getLink(id)! : null; }
  setLinkHealth(id: string, health: { status: LinkHealthStatus; httpStatus: number | null; redirectUrl: string | null; error: string | null }) { const timestamp=now(); const result=this.db.prepare('UPDATE links SET health_status=?,health_checked_at=?,health_http_status=?,health_redirect_url=?,health_error=? WHERE id=? AND deleted_at IS NULL').run(health.status,timestamp,health.httpStatus,health.redirectUrl,health.error,id); return result.changes ? this.getLink(id)! : null; }
  resetLinkHealth(id: string) { this.db.prepare("UPDATE links SET health_status='unchecked',health_checked_at=NULL,health_http_status=NULL,health_redirect_url=NULL,health_error=NULL WHERE id=? AND deleted_at IS NULL").run(id); return this.getLink(id); }
  applyLinkRedirect(id: string) { const row=this.db.prepare("SELECT health_redirect_url FROM links WHERE id=? AND deleted_at IS NULL AND health_status='redirected'").get(id) as SqlRow | undefined; if (!row?.health_redirect_url) return null; this.db.prepare("UPDATE links SET url=?,health_status='ok',health_redirect_url=NULL,health_error=NULL,updated_at=? WHERE id=?").run(String(row.health_redirect_url),now(),id); return this.getLink(id)!; }
  deleteLink(id: string) { const timestamp = now(); return this.db.prepare('UPDATE links SET deleted_at=?, deleted_by_folder_id=NULL, updated_at=? WHERE id=? AND deleted_at IS NULL').run(timestamp, timestamp, id).changes > 0; }
  mergeLinks(keepId: string, mergeIds: string[]) {
    return this.transaction(() => {
      const ids = [...new Set(mergeIds)].filter(id => id !== keepId); if (!ids.length) throw new Error('At least one duplicate link is required');
      const keep = this.db.prepare('SELECT * FROM links WHERE id=? AND deleted_at IS NULL').get(keepId) as SqlRow | undefined; if (!keep) throw new Error('Unknown keep link');
      const sources = ids.map(id => this.db.prepare('SELECT * FROM links WHERE id=? AND deleted_at IS NULL').get(id) as SqlRow | undefined); if (sources.some(row => !row)) throw new Error('Unknown duplicate link');
      const rows = [keep, ...(sources as SqlRow[])]; if (rows.some(row => row.url !== keep.url)) throw new Error('Only links with the same URL can be merged');
      const pick = (field: string) => { const value = rows.map(row => row[field]).find(candidate => candidate !== null && candidate !== undefined && candidate !== ''); return typeof value === 'string' ? value : null; };
      const succeeded = rows.find(row => row.metadata_status === 'succeeded'); const timestamp = now(); const metadataStatus = succeeded ? 'succeeded' : String(keep.metadata_status); const metadataFetchedAt = succeeded && typeof succeeded.metadata_fetched_at === 'string' ? succeeded.metadata_fetched_at : pick('metadata_fetched_at');
      this.db.prepare('UPDATE links SET title=?,description=?,favicon_url=?,display_name=?,appearance_override_json=?,metadata_status=?,metadata_error=?,metadata_fetched_at=?,updated_at=? WHERE id=?').run(pick('title'), pick('description'), pick('favicon_url'), pick('display_name'), pick('appearance_override_json'), metadataStatus, succeeded ? null : pick('metadata_error'), metadataFetchedAt, timestamp, keepId);
      for (const sourceId of ids) {
        const events = this.db.prepare('SELECT id FROM click_events WHERE link_id=?').all(sourceId) as SqlRow[];
        for (const event of events) this.db.prepare('INSERT OR IGNORE INTO link_merge_clicks (event_id,source_link_id,keep_link_id,merged_at) VALUES (?,?,?,?)').run(String(event.id), sourceId, keepId, timestamp);
        this.db.prepare('UPDATE click_events SET link_id=? WHERE link_id=?').run(keepId, sourceId);
        this.db.prepare('UPDATE links SET deleted_at=?,deleted_by_folder_id=NULL,updated_at=? WHERE id=?').run(timestamp, timestamp, sourceId);
      }
      return { kept:this.getLink(keepId)!, merged:ids.length };
    });
  }
  listTrash() {
    const folderRows = this.db.prepare('SELECT id,name,parent_id,deleted_at FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as SqlRow[];
    const deletedFolderIds = new Set(folderRows.map(row => String(row.id)));
    const folders = folderRows.filter(row => row.parent_id == null || !deletedFolderIds.has(String(row.parent_id))).map(row => {
      const id = String(row.id);
      const descendantCount = Math.max(0, Number((this.db.prepare('WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.deleted_at IS NOT NULL) SELECT COUNT(*) AS count FROM subtree').get(id) as SqlRow).count) - 1);
      const linkCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM links WHERE deleted_at IS NOT NULL AND deleted_by_folder_id=?').get(id) as SqlRow).count);
      return { id, name:String(row.name), deletedAt:String(row.deleted_at), descendantCount, linkCount };
    });
    const links = (this.db.prepare(`SELECT l.id,l.url,l.title,l.display_name,l.deleted_at,f.name AS folder_name FROM links l JOIN folders f ON f.id=l.folder_id WHERE l.deleted_at IS NOT NULL AND l.deleted_by_folder_id IS NULL AND f.deleted_at IS NULL ORDER BY l.deleted_at DESC`).all() as SqlRow[]).map(row => ({ id:String(row.id), url:String(row.url), title:(row.display_name ?? row.title) as string | null, folderName:String(row.folder_name), deletedAt:String(row.deleted_at) }));
    return { folders, links };
  }
  restoreFolder(id: string) {
    return this.transaction(() => {
      const root = this.db.prepare('SELECT id,parent_id FROM folders WHERE id=? AND deleted_at IS NOT NULL').get(id) as SqlRow | undefined;
      if (!root) return false;
      const parentId = root.parent_id == null ? null : String(root.parent_id);
      if (parentId && !this.getFolder(parentId)) this.db.prepare('UPDATE folders SET parent_id=NULL WHERE id=?').run(id);
      const rows = this.db.prepare('WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.deleted_at IS NOT NULL) SELECT id FROM subtree').all(id) as SqlRow[];
      const ids = rows.map(row => String(row.id)); const placeholders = ids.map(() => '?').join(','); const timestamp = now();
      this.db.prepare(`UPDATE folders SET deleted_at=NULL, updated_at=? WHERE id IN (${placeholders})`).run(timestamp, ...ids);
      this.db.prepare(`UPDATE links SET deleted_at=NULL, deleted_by_folder_id=NULL, updated_at=? WHERE folder_id IN (${placeholders}) AND deleted_by_folder_id=?`).run(timestamp, ...ids, id);
      return true;
    });
  }
  restoreLink(id: string) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT folder_id FROM links WHERE id=? AND deleted_at IS NOT NULL AND deleted_by_folder_id IS NULL').get(id) as SqlRow | undefined;
      if (!row) return false;
      const mergedEvents = this.db.prepare('SELECT event_id FROM link_merge_clicks WHERE source_link_id=?').all(id) as SqlRow[];
      for (const event of mergedEvents) this.db.prepare('UPDATE click_events SET link_id=? WHERE id=?').run(id, String(event.event_id));
      this.db.prepare('DELETE FROM link_merge_clicks WHERE source_link_id=?').run(id);
      const originalFolderId = String(row.folder_id); const targetFolderId = this.getFolder(originalFolderId)?.id ?? this.ensureInboxFolder().id; const timestamp = now();
      return this.db.prepare('UPDATE links SET folder_id=?, deleted_at=NULL, deleted_by_folder_id=NULL, updated_at=? WHERE id=?').run(targetFolderId, timestamp, id).changes > 0;
    });
  }
  moveLinksToFolder(ids: string[], folderId: string) {
    return this.transaction(() => {
      if (!this.getFolder(folderId)) throw new Error(`Unknown folder: ${folderId}`);
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length !== ids.length) throw new Error('Link move contains duplicate IDs');
      let position = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM links WHERE folder_id=? AND deleted_at IS NULL').get(folderId) as SqlRow).max_position) + 1;
      const moved: Link[] = [];
      for (const id of uniqueIds) {
        if (!this.getLink(id)) throw new Error(`Unknown link: ${id}`);
        this.db.prepare('UPDATE links SET folder_id=?, position=?, updated_at=? WHERE id=?').run(folderId, position, now(), id);
        position += 1;
        moved.push(this.getLink(id)!);
      }
      return moved;
    });
  }
  reorderLinks(items: Array<{ id: string; folderId: string }>) { this.transaction(() => { const sourceIds=items.map(i=>i.id); if (!sourceIds.length || new Set(sourceIds).size!==sourceIds.length) throw new Error('Link reorder contains duplicate IDs'); const placeholders=sourceIds.map(()=>'?').join(','); const found=this.db.prepare(`SELECT id FROM links WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...sourceIds) as SqlRow[]; if (found.length !== items.length) throw new Error('Unknown link'); for (const [position,item] of items.entries()) { if (!this.getFolder(item.folderId)) throw new Error('Unknown folder'); this.db.prepare('UPDATE links SET folder_id=?, position=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(item.folderId, position, now(), item.id); } }); }
  recordClick(id: string) { if (!this.getLink(id)) return null; const clickedAt=now(); this.db.prepare('INSERT INTO click_events VALUES (?, ?, ?)').run(randomUUID(),id,clickedAt); return this.getLink(id)!; }
  setLinkPinned(id: string, pinned: boolean) { const result=this.db.prepare('UPDATE links SET pinned_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL').run(pinned?now():null,now(),id); return result.changes?this.getLink(id)!:null; }
  recordBrowserHistory(records: BrowserHistoryRecord[]) {
    const timestamp = now();
    const upsert = this.db.prepare(`INSERT INTO browser_history_pages (url,title,last_visit_time,visit_count,first_synced_at,last_synced_at,chrome_removed_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(url) DO UPDATE SET title=CASE WHEN excluded.last_visit_time >= browser_history_pages.last_visit_time THEN excluded.title ELSE browser_history_pages.title END, last_visit_time=MAX(browser_history_pages.last_visit_time,excluded.last_visit_time), visit_count=MAX(browser_history_pages.visit_count,excluded.visit_count), last_synced_at=excluded.last_synced_at, chrome_removed_at=NULL`);
    const event = this.db.prepare('INSERT OR IGNORE INTO browser_history_events (id,url,visited_at,source,created_at) VALUES (?,?,?,?,?)');
    this.transaction(() => { for (const record of records) { const hidden = this.db.prepare('SELECT 1 FROM browser_history_hidden WHERE url=?').get(record.url); if (hidden && record.source !== 'live') continue; if (record.source === 'live') this.db.prepare('DELETE FROM browser_history_hidden WHERE url=?').run(record.url); upsert.run(record.url, record.title, record.lastVisitTime, record.visitCount, timestamp, timestamp); event.run(randomUUID(), record.url, record.lastVisitTime, record.source, timestamp); } });
    return { received: records.length };
  }
  markBrowserHistoryRemoved(removed: { allHistory: boolean; urls?: string[] }) {
    const timestamp = now();
    if (removed.allHistory) return { marked: this.db.prepare('UPDATE browser_history_pages SET chrome_removed_at=? WHERE chrome_removed_at IS NULL').run(timestamp).changes };
    const urls = [...new Set(removed.urls ?? [])];
    if (!urls.length) return { marked: 0 };
    const placeholders = urls.map(() => '?').join(',');
    return { marked: this.db.prepare(`UPDATE browser_history_pages SET chrome_removed_at=? WHERE url IN (${placeholders}) AND chrome_removed_at IS NULL`).run(timestamp, ...urls).changes };
  }
  deleteBrowserHistory(url: string) {
    const timestamp = now();
    return this.transaction(() => {
      const deleted = this.db.prepare('DELETE FROM browser_history_pages WHERE url=?').run(url).changes > 0;
      this.db.prepare('INSERT INTO browser_history_hidden (url, deleted_at) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET deleted_at=excluded.deleted_at').run(url, timestamp);
      return { deleted };
    });
  }
  listBrowserHistory(input: { query?: string; cursor?: { time: number; url: string }; limit: number }) {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.query) { clauses.push('(title LIKE ? COLLATE NOCASE OR url LIKE ? COLLATE NOCASE)'); values.push(`%${input.query}%`, `%${input.query}%`); }
    if (input.cursor) { clauses.push('(last_visit_time < ? OR (last_visit_time = ? AND url > ?))'); values.push(input.cursor.time, input.cursor.time, input.cursor.url); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT url,title,last_visit_time,visit_count,chrome_removed_at FROM browser_history_pages ${where} ORDER BY last_visit_time DESC, url ASC LIMIT ?`).all(...values, input.limit + 1) as SqlRow[];
    const items = rows.slice(0, input.limit).map(historyPageFrom);
    const next = rows.length > input.limit ? items.at(-1) : undefined;
    return { items, nextCursor: next ? { time: next.lastVisitTime, url: next.url } : null };
  }
}
