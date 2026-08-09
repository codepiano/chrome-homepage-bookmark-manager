import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Folder, Link, MetadataStatus } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

type SqlRow = Record<string, unknown>;
const now = () => new Date().toISOString();

function folderFrom(row: SqlRow): Folder {
  return { id: String(row.id), name: String(row.name), position: Number(row.position), createdAt: String(row.created_at), updatedAt: String(row.updated_at), linkCount: Number(row.link_count ?? 0) };
}
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try { const result: unknown = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null; } catch { return null; }
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
  };
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
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT, description TEXT, favicon_url TEXT, display_name TEXT, metadata_status TEXT NOT NULL DEFAULT 'pending' CHECK(metadata_status IN ('pending','succeeded','failed')), metadata_error TEXT, metadata_fetched_at TEXT, appearance_override_json TEXT, position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS links_folder_position ON links(folder_id, position, id);
      CREATE TABLE IF NOT EXISTS click_events (id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, clicked_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS click_events_link_time ON click_events(link_id, clicked_at DESC);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const existing = this.db.prepare('SELECT id FROM settings WHERE id = 1').get();
    if (!existing) this.db.prepare('INSERT INTO settings (id, value_json, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(DEFAULT_SETTINGS), now());
  }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  getSettings() { const row = this.db.prepare('SELECT value_json, updated_at FROM settings WHERE id=1').get() as SqlRow; return { ...DEFAULT_SETTINGS, ...jsonObject(row.value_json), updatedAt: row.updated_at }; }
  setSettings(value: Record<string, unknown>) { const current = this.getSettings(); const next = { ...current, ...value }; delete (next as Record<string, unknown>).updatedAt; const timestamp = now(); this.db.prepare('UPDATE settings SET value_json=?, updated_at=? WHERE id=1').run(JSON.stringify(next), timestamp); return { ...next, updatedAt: timestamp }; }
  listFolders() { return (this.db.prepare('SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id GROUP BY f.id ORDER BY f.position, f.id').all() as SqlRow[]).map(folderFrom); }
  getFolder(id: string) { const row = this.db.prepare('SELECT f.*, COUNT(l.id) AS link_count FROM folders f LEFT JOIN links l ON l.folder_id=f.id WHERE f.id=? GROUP BY f.id').get(id) as SqlRow | undefined; return row && folderFrom(row); }
  createFolder(name: string) { const timestamp = now(), id = randomUUID(); const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM folders').get() as SqlRow; this.db.prepare('INSERT INTO folders VALUES (?, ?, ?, ?, ?)').run(id, name, Number(row.max_position) + 1, timestamp, timestamp); return this.getFolder(id)!; }
  updateFolder(id: string, name: string) { const change = this.db.prepare('UPDATE folders SET name=?, updated_at=? WHERE id=?').run(name, now(), id); return change.changes ? this.getFolder(id)! : null; }
  deleteFolder(id: string) { return this.db.prepare('DELETE FROM folders WHERE id=?').run(id).changes > 0; }
  reorderFolders(ids: string[]) { this.transaction(() => { const count = (this.db.prepare('SELECT COUNT(*) AS count FROM folders').get() as SqlRow).count; if (ids.length !== Number(count) || new Set(ids).size !== ids.length) throw new Error('Folder reorder must include every folder exactly once'); for (const [position, id] of ids.entries()) if (this.db.prepare('UPDATE folders SET position=?, updated_at=? WHERE id=?').run(position, now(), id).changes !== 1) throw new Error('Unknown folder'); }); return this.listFolders(); }
  listLinks(folderId: string) { return (this.db.prepare(`SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l LEFT JOIN click_events c ON c.link_id=l.id WHERE l.folder_id=? GROUP BY l.id ORDER BY l.position, l.id`).all(folderId) as SqlRow[]).map(linkFrom); }
  getLink(id: string) { const row = this.db.prepare(`SELECT l.*, COUNT(c.id) AS click_count, MAX(c.clicked_at) AS last_clicked_at FROM links l LEFT JOIN click_events c ON c.link_id=l.id WHERE l.id=? GROUP BY l.id`).get(id) as SqlRow | undefined; return row && linkFrom(row); }
  createLink(folderId: string, fields: { url: string; title?: string | null; description?: string | null; displayName?: string | null }) { if (!this.getFolder(folderId)) return null; const timestamp=now(), id=randomUUID(); const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM links WHERE folder_id=?').get(folderId) as SqlRow; this.db.prepare('INSERT INTO links (id,folder_id,url,title,description,display_name,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, folderId, fields.url, fields.title ?? null, fields.description ?? null, fields.displayName ?? null, Number(max.max_position)+1, timestamp, timestamp); return this.getLink(id)!; }
  updateLink(id: string, fields: Record<string, unknown>) { const allowed: Record<string, string> = { url:'url', title:'title', description:'description', faviconUrl:'favicon_url', displayName:'display_name', appearanceOverride:'appearance_override_json' }; const values: Array<string | null>=[]; const changes: string[]=[]; for (const [key, column] of Object.entries(allowed)) if (key in fields) { changes.push(`${column}=?`); values.push(key === 'appearanceOverride' && fields[key] !== null ? JSON.stringify(fields[key]) : typeof fields[key] === 'string' ? fields[key] : null); } if (!changes.length) return this.getLink(id); values.push(now(), id); const result=this.db.prepare(`UPDATE links SET ${changes.join(', ')}, updated_at=? WHERE id=?`).run(...values); return result.changes ? this.getLink(id)! : null; }
  setMetadata(id: string, metadata: { title?: string | null; description?: string | null; faviconUrl?: string | null; status: MetadataStatus; error?: string | null }) { const result=this.db.prepare('UPDATE links SET title=COALESCE(?,title), description=COALESCE(?,description), favicon_url=COALESCE(?,favicon_url), metadata_status=?, metadata_error=?, metadata_fetched_at=?, updated_at=? WHERE id=?').run(metadata.title ?? null, metadata.description ?? null, metadata.faviconUrl ?? null, metadata.status, metadata.error ?? null, now(), now(), id); return result.changes ? this.getLink(id)! : null; }
  deleteLink(id: string) { return this.db.prepare('DELETE FROM links WHERE id=?').run(id).changes > 0; }
  reorderLinks(items: Array<{ id: string; folderId: string }>) { this.transaction(() => { const sourceIds=items.map(i=>i.id); if (!sourceIds.length || new Set(sourceIds).size!==sourceIds.length) throw new Error('Link reorder contains duplicate IDs'); const placeholders=sourceIds.map(()=>'?').join(','); const found=this.db.prepare(`SELECT id FROM links WHERE id IN (${placeholders})`).all(...sourceIds) as SqlRow[]; if (found.length !== items.length) throw new Error('Unknown link'); for (const [position,item] of items.entries()) { if (!this.getFolder(item.folderId)) throw new Error('Unknown folder'); this.db.prepare('UPDATE links SET folder_id=?, position=?, updated_at=? WHERE id=?').run(item.folderId, position, now(), item.id); } }); }
  recordClick(id: string) { if (!this.getLink(id)) return null; const clickedAt=now(); this.db.prepare('INSERT INTO click_events VALUES (?, ?, ?)').run(randomUUID(),id,clickedAt); return this.getLink(id)!; }
}
