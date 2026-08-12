import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getDomain, getSubdomain } from 'tldts';
import { api, defaultConnection, getConnection, getLastGoodSnapshot, saveConnection, saveLastGoodSnapshot, type ConnectionPreferences } from './api';
import { defaultSettings, type BrowserHistoryPage, type Folder, type Link, type LinkAppearance, type LinkDraft, type Recommendation, type Settings } from './types';
import './styles.css';

type Dialog = { type: 'link'; link?: Link; initial?: Partial<LinkDraft>; deleteArmed?: boolean } | { type: 'folder'; folder?: Folder } | { type: 'settings' } | { type: 'connection' } | null;
type ViewMode = 'browse' | 'organize';
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const displayTitle = (link: Link) => link.displayName || link.title || new URL(link.url).hostname;
const displayHost = (url: string) => { try { return new URL(url).hostname || new URL(url).protocol.replace(':', ''); } catch { return url; } };
const normalizeLinkUrl = (value: string) => {
  const url = value.trim();
  return url && !/^[a-z][a-z\d+.-]*:/i.test(url) ? `https://${url}` : url;
};
const cardStyle = (link: Link) => ({
  '--card-accent': link.appearanceOverride?.accentColor ?? 'var(--accent)',
  '--card-background': link.appearanceOverride?.cardColor ?? 'var(--surface)',
} as React.CSSProperties);

function LinkContents({ link, settings }: { link: Link; settings: Settings }) {
  const title = displayTitle(link);
  const initial = title.trim().slice(0, 1).toUpperCase() || '·';
  const customIcon = link.appearanceOverride?.icon;
  return <><span className="card-main">
    {customIcon ? <span className="favicon fallback custom-icon">{customIcon}</span> : link.faviconUrl ? <img className="favicon" src={link.faviconUrl} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <span className="favicon fallback">{initial}</span>}
    <span className="card-copy"><strong>{title}</strong>{settings.showDescription && link.description && <span className="description">{link.description}</span>}
      {(settings.showClickCount || settings.showLastVisited) && <span className="metrics">{settings.showClickCount && `${link.clickCount} 次访问`}{settings.showClickCount && settings.showLastVisited && link.lastClickedAt && ' · '}{settings.showLastVisited && link.lastClickedAt && `最近 ${dateFormat.format(new Date(link.lastClickedAt))}`}</span>}
    </span>
  </span>{link.metadataStatus !== 'succeeded' && <span className={`metadata ${link.metadataStatus}`}>{link.metadataStatus === 'pending' ? '正在补充信息' : '自动信息未获取'}</span>}</>;
}

function BrowseCard({ link, settings, onRecord, onRetry }: { link: Link; settings: Settings; onRecord(): void; onRetry(): void }) {
  const title = displayTitle(link);
  return <article style={cardStyle(link)} className={`link-card link-card-open ${settings.layout}`}><a className="card-link" href={link.url} aria-label={`打开 ${title}`} onClick={onRecord}><LinkContents link={link} settings={settings} /></a>{link.metadataStatus === 'failed' && <button type="button" className="retry-metadata" title={link.metadataError ?? '重新抓取标题、简介和图标'} onClick={onRetry}>重新抓取</button>}</article>;
}

function SortableTab({ folder, active, onSelect }: { folder: Folder; active: boolean; onSelect(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: folder.id });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="tab-wrap">
    <button className={`tab ${active ? 'active' : ''}`} onClick={onSelect} {...attributes} {...listeners} aria-label={`${folder.name}，可拖动排序`}>{folder.name}</button>
  </div>;
}

function SortableCard({ link, settings, onOpen, onEdit }: { link: Link; settings: Settings; onOpen(): void; onEdit(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: link.id });
  const title = displayTitle(link);
  return <article ref={setNodeRef} style={{ ...cardStyle(link), transform: CSS.Transform.toString(transform), transition }} className={`link-card organize-card ${settings.layout} ${isDragging ? 'dragging' : ''}`} {...attributes}>
    <button type="button" className="organize-open" onClick={onOpen} aria-label={`打开 ${title}`}><LinkContents link={link} settings={settings} /></button>
    <div className="card-actions"><button type="button" className="card-action" onClick={onEdit}>编辑</button><button type="button" className="card-action drag-handle" {...listeners} aria-label={`拖动 ${title} 排序`}>拖动</button></div>
  </article>;
}

function Toast({ children }: { children: React.ReactNode }) { return <p className="toast" role="status">{children}</p>; }

function RecommendationStrip({ links, settings, onOpen }: { links: Recommendation[]; settings: Settings; onOpen(link: Link): void }) {
  if (!links.length) return null;
  return <section className="recommendations" aria-label="推荐访问"><div className="recommendations-heading"><div><h2>推荐访问</h2><p>综合访问频率与近期使用排序</p></div></div><div className="highlight-links">{links.map((link) => <a key={link.id} style={cardStyle(link)} className="highlight-card" href={link.url} onClick={() => onOpen(link)}><LinkContents link={link} settings={settings} /></a>)}</div></section>;
}

function BookmarkSearch({ query, links, folders, onQueryChange, onOpen }: { query: string; links: Link[]; folders: Folder[]; onQueryChange(value: string): void; onOpen(link: Link): void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); inputRef.current?.focus(); }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) { onQueryChange(''); inputRef.current?.blur(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onQueryChange]);
  const normalized = query.trim().toLocaleLowerCase();
  const results = normalized ? links.filter((link) => [displayTitle(link), link.url, link.description ?? '', folders.find((folder) => folder.id === link.folderId)?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(normalized))).slice(0, 12) : [];
  useEffect(() => { setActiveIndex(0); }, [normalized]);
  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => (current + 1) % results.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => (current - 1 + results.length) % results.length); }
    if (event.key === 'Enter') { event.preventDefault(); onOpen(results[activeIndex] ?? results[0]); }
  }
  return <section className={`bookmark-search ${normalized ? 'has-query' : ''}`} aria-label="搜索书签"><label><span className="visually-hidden">搜索书签</span><input ref={inputRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={Boolean(normalized)} aria-controls="bookmark-search-results" aria-activedescendant={results[activeIndex] ? `bookmark-result-${results[activeIndex].id}` : undefined} value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="搜索书签" /><kbd>⌘K</kbd></label>{normalized && <div id="bookmark-search-results" className="search-results" role="listbox" aria-label="书签搜索结果">{results.length ? results.map((link, index) => { const folder = folders.find((item) => item.id === link.folderId); return <button id={`bookmark-result-${link.id}`} key={link.id} type="button" role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => onOpen(link)}><span><strong>{displayTitle(link)}</strong><small>{folder?.name ?? '未分类'} · {displayHost(link.url)}</small></span><span aria-hidden="true">打开</span></button>; }) : <p>没有匹配的书签</p>}</div>}</section>;
}

function App() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [libraryLinks, setLibraryLinks] = useState<Record<string, Link[]>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [mode, setMode] = useState<ViewMode>('browse');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offlineSnapshot, setOfflineSnapshot] = useState(false);
  const clickRetryQueue = useRef(new Set<string>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const rootStyle = useMemo(() => ({ '--accent': settings.accentColor, ...(settings.textColor ? { '--text': settings.textColor } : {}), '--card-width': `${settings.cardWidth}px`, '--gap': `${settings.gap}px`, '--columns': String(settings.columns), '--grid-justify': 'start', fontFamily: settings.fontFamily } as React.CSSProperties), [settings]);

  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 3600); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => { if (offlineSnapshot) setMode('browse'); }, [offlineSnapshot]);

  async function flushClickRetryQueue() {
    await Promise.all([...clickRetryQueue.current].map(async (id) => { try { await api.click(id); clickRetryQueue.current.delete(id); } catch { /* Retry after the next successful load. */ } }));
  }
  async function load() {
    setLoading(true); setError(null);
    try {
      const [nextFolders, nextSettings] = await Promise.all([api.folders(), api.settings()]);
      const linksByFolder = Object.fromEntries(await Promise.all(nextFolders.map(async (folder) => [folder.id, await api.links(folder.id)] as const)));
      setFolders(nextFolders); setSettings({ ...defaultSettings, ...nextSettings }); setLibraryLinks(linksByFolder);
      setSelectedFolderId((current) => nextFolders.some((folder) => folder.id === current) ? current : nextFolders[0]?.id ?? null);
      setLinks(linksByFolder[nextFolders.find((folder) => folder.id === selectedFolderId)?.id ?? nextFolders[0]?.id] ?? []);
      setOfflineSnapshot(false); await saveLastGoodSnapshot({ folders: nextFolders, linksByFolder, settings: { ...defaultSettings, ...nextSettings } }); await flushClickRetryQueue();
      void api.recommendations().then((result) => setRecommendations(result.recommendations)).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接本机服务');
      const snapshot = await getLastGoodSnapshot();
      if (snapshot) {
        setFolders(snapshot.folders); setSettings({ ...defaultSettings, ...snapshot.settings }); setLibraryLinks(snapshot.linksByFolder);
        setSelectedFolderId((current) => snapshot.folders.some((folder) => folder.id === current) ? current : snapshot.folders[0]?.id ?? null);
        setLinks(snapshot.linksByFolder[snapshot.folders.find((folder) => folder.id === selectedFolderId)?.id ?? snapshot.folders[0]?.id] ?? []); setOfflineSnapshot(true);
      }
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selectedFolderId) { setLinks([]); return; }
    if (offlineSnapshot) { void getLastGoodSnapshot().then((snapshot) => setLinks(snapshot?.linksByFolder[selectedFolderId] ?? [])); return; }
    api.links(selectedFolderId).then(setLinks).catch((cause) => setError(cause.message));
  }, [selectedFolderId, offlineSnapshot]);

  function recordLinkClick(link: Link) { void Promise.race([api.click(link.id), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 800))]).then(() => api.recommendations().then((result) => setRecommendations(result.recommendations))).catch(() => clickRetryQueue.current.add(link.id)); }
  function openLink(link: Link) { recordLinkClick(link); window.location.assign(link.url); }
  function updateLibraryLink(next: Link, previousFolderId = next.folderId) {
    setLibraryLinks((current) => {
      const updated = { ...current };
      if (previousFolderId !== next.folderId) updated[previousFolderId] = (updated[previousFolderId] ?? []).filter((item) => item.id !== next.id);
      const target = updated[next.folderId] ?? [];
      updated[next.folderId] = target.some((item) => item.id === next.id) ? target.map((item) => item.id === next.id ? next : item) : [...target, next];
      return updated;
    });
  }
  async function reorderFolders(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const previous = folders; const next = arrayMove(folders, folders.findIndex((folder) => folder.id === event.active.id), folders.findIndex((folder) => folder.id === event.over?.id)); setFolders(next);
    try { await api.reorderFolders(next.map((folder) => folder.id)); setToast('标签顺序已保存'); } catch (cause) { setFolders(previous); setError(`标签排序未保存：${(cause as Error).message}`); }
  }
  async function reorderLinks(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id || !selectedFolderId) return;
    const previous = links; const next = arrayMove(links, links.findIndex((link) => link.id === event.active.id), links.findIndex((link) => link.id === event.over?.id)); setLinks(next);
    try { await api.reorderLinks(next.map((link) => ({ id: link.id, folderId: selectedFolderId }))); setToast('链接顺序已保存'); } catch (cause) { setLinks(previous); setError(`链接排序未保存：${(cause as Error).message}`); }
  }
  async function retryMetadata(link: Link) {
    try {
      const next = await api.refreshMetadata(link.id);
      setLinks((items) => items.map((item) => item.id === next.id ? next : item));
      updateLibraryLink(next);
      setToast(next.metadataStatus === 'succeeded' ? '网页信息已更新' : `未能抓取：${next.metadataError ?? '请稍后再试'}`);
    } catch (cause) { setToast(`重新抓取失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); }
  }
  function deleteFolder(id: string, name: string) { setFolders((items) => { const next = items.filter((item) => item.id !== id); setSelectedFolderId((current) => current === id ? next[0]?.id ?? null : current); return next; }); setLinks((items) => selectedFolderId === id ? [] : items); setLibraryLinks((current) => { const next = { ...current }; delete next[id]; return next; }); setDialog(null); setToast(`已删除标签“${name}”`); }

  const historyTab = <div className="tab-wrap"><button className={`tab history-tab ${showHistory ? 'active' : ''}`} onClick={() => { setShowHistory(true); setMode('browse'); }}>浏览记录</button></div>;
  const tabs = !loading && (mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderFolders(event)}><nav className="tabs organize-tabs" aria-label="书签标签">{historyTab}<SortableContext items={folders.map((folder) => folder.id)} strategy={horizontalListSortingStrategy}>{folders.map((folder) => <SortableTab key={folder.id} folder={folder} active={!showHistory && folder.id === selectedFolderId} onSelect={() => { setShowHistory(false); setSelectedFolderId(folder.id); }} />)}</SortableContext><button className="tab-add" onClick={() => setDialog({ type: 'folder' })}>添加标签</button></nav></DndContext> : <nav className="tabs" aria-label="书签标签">{historyTab}{folders.map((folder) => <div className="tab-wrap" key={folder.id}><button className={`tab ${!showHistory && folder.id === selectedFolderId ? 'active' : ''}`} onClick={() => { setShowHistory(false); setSelectedFolderId(folder.id); }}>{folder.name}</button></div>)}</nav>);

  return <main className={`app theme-${settings.theme} ${settings.compact ? 'compact' : ''} mode-${mode}`} style={rootStyle}>
    <header className="header"><h1>快速访问</h1><BookmarkSearch query={searchQuery} links={Object.values(libraryLinks).flat()} folders={folders} onQueryChange={setSearchQuery} onOpen={openLink} /><div className="header-actions"><button className="quiet-button" onClick={() => setDialog({ type: 'settings' })}>设置</button>{!offlineSnapshot && <button className={mode === 'organize' ? 'primary' : 'quiet-button'} onClick={() => { setShowHistory(false); setMode((current) => current === 'browse' ? 'organize' : 'browse'); }}>{mode === 'organize' ? '完成整理' : '整理书签'}</button>}</div></header>
    {error && <aside className="connection-error" role="alert"><span>无法连接本机服务：{error}{offlineSnapshot ? '。正在显示上次成功同步的只读快照。' : ''}</span><button onClick={() => void load()}>重试</button><button onClick={() => setDialog({ type: 'connection' })}>检查连接</button></aside>}
    {!offlineSnapshot && !showHistory && mode === 'browse' && settings.showRecommendations && <RecommendationStrip links={recommendations} settings={settings} onOpen={recordLinkClick} />}
    {tabs}
    <section className="content" aria-busy={loading}>{loading ? <p className="state">正在连接本机书签库…</p> : showHistory ? <HistoryPanel onOpen={(url) => window.location.assign(url)} onAdd={(item) => selectedFolderId ? setDialog({ type: 'link', initial: { url: item.url, title: item.title } }) : setToast('请先创建一个标签，再将记录添加为书签。')} /> : !selectedFolder ? <Empty onAdd={() => setDialog({ type: 'folder' })} /> : <>
      <div className="section-heading"><div><h2>{selectedFolder.name}</h2><p>{links.length} 个链接{offlineSnapshot ? ' · 离线快照只读' : mode === 'organize' ? ' · 可拖动标签或链接排序' : ''}</p></div>{!offlineSnapshot && <button className="text-button" onClick={() => setDialog({ type: 'folder', folder: selectedFolder })}>管理此标签</button>}</div>
      {mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderLinks(event)}><SortableContext items={links.map((link) => link.id)} strategy={rectSortingStrategy}><div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <SortableCard key={link.id} link={link} settings={settings} onOpen={() => openLink(link)} onEdit={() => setDialog({ type: 'link', link })} />)}<AddCard folderName={selectedFolder.name} empty={links.length === 0} onClick={() => setDialog({ type: 'link' })} /></div></SortableContext></DndContext> : <div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <BrowseCard key={link.id} link={link} settings={settings} onRecord={() => recordLinkClick(link)} onRetry={() => void retryMetadata(link)} />)}{!offlineSnapshot && <AddCard folderName={selectedFolder.name} empty={links.length === 0} onClick={() => setDialog({ type: 'link' })} />}</div>}
    </>}</section>
    {toast && <Toast>{toast}</Toast>}
    {dialog?.type === 'link' && selectedFolderId && <LinkDialog link={dialog.link} initial={dialog.initial} initialDeleteArmed={dialog.deleteArmed} folderId={selectedFolderId} folders={folders} onClose={() => setDialog(null)} onSaved={(next) => { updateLibraryLink(next, dialog.link?.folderId); setLinks((items) => { const exists = items.some((item) => item.id === next.id); if (next.folderId !== selectedFolderId) return exists ? items.filter((item) => item.id !== next.id) : items; return exists ? items.map((item) => item.id === next.id ? next : item) : [...items, next]; }); setDialog(null); setToast(dialog.link ? '链接已更新' : '链接已添加'); }} onDeleted={(id, name) => { setLinks((items) => items.filter((item) => item.id !== id)); setLibraryLinks((current) => Object.fromEntries(Object.entries(current).map(([folderId, items]) => [folderId, items.filter((item) => item.id !== id)]))); setDialog(null); setToast(`已删除链接“${name}”`); }} />}
    {dialog?.type === 'folder' && <FolderDialog folder={dialog.folder} linkCount={dialog.folder?.id === selectedFolderId ? links.length : dialog.folder?.linkCount ?? 0} onClose={() => setDialog(null)} onSaved={(next) => { setFolders((items) => dialog.folder ? items.map((item) => item.id === next.id ? next : item) : [...items, next]); setSelectedFolderId(next.id); setDialog(null); const moved = (next as Folder & { autoCollected?: number }).autoCollected ?? 0; setToast(dialog.folder ? moved ? `标签已更新，已自动归集 ${moved} 个链接` : '标签已更新' : '标签已添加'); void load(); }} onDeleted={deleteFolder} />}
    {dialog?.type === 'settings' && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onOpenConnection={() => setDialog({ type: 'connection' })} onSaved={(next) => { setSettings(next); setDialog(null); setToast('显示设置已保存'); }} />}
    {dialog?.type === 'connection' && <ConnectionDialog onClose={() => setDialog(null)} />}
  </main>;
}

function AddCard({ folderName, empty, onClick }: { folderName: string; empty: boolean; onClick(): void }) { return <button className="add-card" onClick={onClick} aria-label={`在${folderName}中添加链接`}><strong>添加链接</strong><small>{empty ? '从第一个网址开始' : `添加到“${folderName}”`}</small></button>; }
function Empty({ onAdd }: { onAdd(): void }) { return <div className="empty"><h2>从第一个标签开始</h2><ol className="starter-steps"><li>创建标签，例如“工作”或“常用”</li><li>添加第一个网址，可填写自己的标题和简介</li><li>以后打开新标签页，直接点击卡片访问</li></ol><button className="primary" onClick={onAdd}>创建第一个标签</button></div>; }

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown); }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button className="quiet-button" onClick={onClose}>关闭</button></header>{children}</section></div>;
}

function historyDayLabel(timestamp: number) {
  const date = new Date(timestamp); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}

function historyFullHostname(url: string) { try { return new URL(url).hostname; } catch { return url; } }
function historyHostname(url: string) { return historyFullHostname(url).replace(/^www\./, ''); }
type DomainBranch = { label: string; hostname: string; items: BrowserHistoryPage[]; children: Map<string, DomainBranch> };
type DomainGroup = { domain: string; items: BrowserHistoryPage[]; children: Map<string, DomainBranch> };
function domainGroups(entries: BrowserHistoryPage[]) {
  const groups = new Map<string, DomainGroup>();
  for (const item of entries) {
    const hostname = historyHostname(item.url); const domain = getDomain(item.url, { allowPrivateDomains: true }) ?? hostname;
    let group = groups.get(domain);
    if (!group) { group = { domain, items: [], children: new Map() }; groups.set(domain, group); }
    const subdomain = getSubdomain(item.url, { allowPrivateDomains: true });
    if (!subdomain) { group.items.push(item); continue; }
    let children = group.children; const labels = subdomain.split('.').reverse(); const hostnameParts: string[] = [];
    for (const label of labels) {
      hostnameParts.unshift(label); let child = children.get(label);
      if (!child) { child = { label, hostname: `${hostnameParts.join('.')}.${domain}`, items: [], children: new Map() }; children.set(label, child); }
      child.items.push(item); children = child.children;
    }
  }
  return [...groups.values()];
}
function HistoryItem({ item, onOpen, onAdd }: { item: BrowserHistoryPage; onOpen(url: string): void; onAdd(item: BrowserHistoryPage): void }) {
  const title = item.title || historyHostname(item.url); const initial = title.trim().slice(0, 1).toUpperCase() || '·';
  return <article className="history-item"><button type="button" className="history-open" onClick={() => onOpen(item.url)} aria-label={`打开 ${title}`}><span className="history-mark" aria-hidden="true">{initial}</span><span className="history-copy"><strong>{title}</strong><span className="history-domain">{historyHostname(item.url)}</span></span><span className="history-meta"><time dateTime={new Date(item.lastVisitTime).toISOString()}>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.lastVisitTime))}</time>{item.visitCount > 0 && <span>{item.visitCount} 次访问</span>}</span></button><button type="button" className="history-add quiet-button" onClick={() => onAdd(item)}>加入标签</button></article>;
}
function HistoryDomainBranch({ branch, depth, onOpen, onAdd }: { branch: DomainBranch; depth: number; onOpen(url: string): void; onAdd(item: BrowserHistoryPage): void }) {
  const directItems = branch.items.filter((item) => historyFullHostname(item.url) === branch.hostname);
  return <section className="history-domain-branch" style={{ '--domain-depth': String(depth) } as React.CSSProperties}><h4>{branch.hostname}<span>{branch.items.length} 条</span></h4>{directItems.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} />)}{[...branch.children.values()].map((child) => <HistoryDomainBranch key={child.hostname} branch={child} depth={depth + 1} onOpen={onOpen} onAdd={onAdd} />)}</section>;
}

function HistoryPanel({ onOpen, onAdd }: { onOpen(url: string): void; onAdd(item: BrowserHistoryPage): void }) {
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<'date' | 'domain'>('date');
  const [entries, setEntries] = useState<BrowserHistoryPage[]>([]);
  const [nextCursor, setNextCursor] = useState<{ time: number; url: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestSerial = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadMoreSentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const requestId = ++requestSerial.current;
    setLoading(true); setMessage(null); setNextCursor(null);
    const timeout = window.setTimeout(() => {
      void api.history(query.trim()).then((result) => {
        if (requestSerial.current !== requestId) return;
        setEntries(result.items); setNextCursor(result.nextCursor);
      }).catch((cause) => { if (requestSerial.current === requestId) { setEntries([]); setMessage(cause instanceof Error ? cause.message : '无法读取本地浏览记录'); } }).finally(() => { if (requestSerial.current === requestId) setLoading(false); });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query]);
  async function loadMore() {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try { const result = await api.history(query.trim(), nextCursor); setEntries((current) => [...current, ...result.items]); setNextCursor(result.nextCursor); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '无法读取更多记录'); } finally { loadingMoreRef.current = false; setLoadingMore(false); }
  }
  useEffect(() => {
    const target = loadMoreSentinel.current;
    if (!target || !nextCursor) return;
    const observer = new IntersectionObserver((records) => { if (records.some((record) => record.isIntersecting)) void loadMore(); }, { rootMargin: '360px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [nextCursor, query]);
  const groups = entries.reduce<Array<{ label: string; items: BrowserHistoryPage[] }>>((result, item) => { const label = historyDayLabel(item.lastVisitTime); const group = result.at(-1); if (group?.label === label) group.items.push(item); else result.push({ label, items: [item] }); return result; }, []);
  const byDomain = domainGroups(entries);
  const emptyMessage = query.trim() ? '没有找到匹配的浏览记录。试试缩短关键词或搜索网址。' : '还没有同步到本机的浏览记录。打开几个网页后，它们会出现在这里。';
  return <div className="history-panel"><div className="section-heading"><div><h2>浏览记录</h2><p>保存在本机 · 最近访问优先</p></div>{!loading && entries.length > 0 && <span className="history-count">已显示 {entries.length} 条</span>}</div><div className="history-controls"><label>搜索记录<input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或网址" /></label><div className="history-group-switch" aria-label="分组方式"><button type="button" className={groupBy === 'date' ? 'active' : ''} onClick={() => setGroupBy('date')}>按日期</button><button type="button" className={groupBy === 'domain' ? 'active' : ''} onClick={() => setGroupBy('domain')}>按域名</button></div></div>{message && <p className="form-error">{message}</p>}<div className={`history-list ${groupBy === 'domain' ? 'grouped-by-domain' : ''}`} aria-busy={loading}>{loading ? <p className="history-state">正在读取本机浏览记录…</p> : entries.length === 0 ? <p className="history-state">{emptyMessage}</p> : groupBy === 'date' ? groups.map((group) => <section className="history-day" key={group.label}><h3>{group.label}<span>{group.items.length} 条</span></h3>{group.items.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} />)}</section>) : byDomain.map((group) => <section className="history-domain-group" key={group.domain}><h3>{group.domain}<span>{group.items.length + [...group.children.values()].reduce((total, child) => total + child.items.length, 0)} 条</span></h3>{group.items.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} />)}{[...group.children.values()].map((branch) => <HistoryDomainBranch key={branch.hostname} branch={branch} depth={1} onOpen={onOpen} onAdd={onAdd} />)}</section>)}</div>{nextCursor && <div ref={loadMoreSentinel} className="history-load-sentinel" aria-live="polite">{loadingMore ? '正在加载更多记录…' : ''}</div>}</div>;
}

function LinkDialog({ link, initial, initialDeleteArmed = false, folderId, folders, onClose, onSaved, onDeleted }: { link?: Link; initial?: Partial<LinkDraft>; initialDeleteArmed?: boolean; folderId: string; folders: Folder[]; onClose(): void; onSaved(link: Link): void; onDeleted(id: string, name: string): void }) {
  const [draft, setDraft] = useState<LinkDraft>({ url: link?.url ?? initial?.url ?? '', title: link?.title ?? initial?.title ?? '', description: link?.description ?? initial?.description ?? '', faviconUrl: link?.faviconUrl ?? initial?.faviconUrl ?? '', displayName: link?.displayName ?? initial?.displayName ?? '', appearanceOverride: link?.appearanceOverride ?? initial?.appearanceOverride ?? null });
  const [targetFolderId, setTargetFolderId] = useState(link?.folderId ?? folderId); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [deleteArmed, setDeleteArmed] = useState(initialDeleteArmed); const [duplicates, setDuplicates] = useState<Link[]>([]); const [showAdvanced, setShowAdvanced] = useState(Boolean(link));
  const update = <K extends keyof LinkDraft>(field: K, value: LinkDraft[K]) => setDraft((previous) => ({ ...previous, [field]: value }));
  const updateAppearance = <K extends keyof LinkAppearance>(field: K, value: LinkAppearance[K]) => update('appearanceOverride', { ...(draft.appearanceOverride ?? {}), [field]: value });
  useEffect(() => {
    if (link || !draft.url.trim()) { setDuplicates([]); return; }
    const timeout = window.setTimeout(() => { void api.duplicates(normalizeLinkUrl(draft.url)).then(setDuplicates).catch(() => setDuplicates([])); }, 250);
    return () => window.clearTimeout(timeout);
  }, [draft.url, link]);
  async function save(event: React.FormEvent) { event.preventDefault(); setBusy(true); setMessage(null); try { const normalized = { ...draft, url: normalizeLinkUrl(draft.url), faviconUrl: draft.faviconUrl?.trim() || null, appearanceOverride: draft.appearanceOverride ?? null }; const next = link ? await api.updateLink(link.id, normalized) : await api.createLink(targetFolderId, { url: normalized.url, title: normalized.title?.trim() || null, description: normalized.description?.trim() || null, displayName: normalized.displayName?.trim() || null, appearanceOverride: normalized.appearanceOverride }); const saved = link && targetFolderId !== link.folderId ? (await api.reorderLinks([{ id: next.id, folderId: targetFolderId }]), { ...next, folderId: targetFolderId }) : next; if (!link && /^https?:\/\//i.test(next.url)) void api.refreshMetadata(next.id).then(onSaved).catch(() => undefined); onSaved(saved); } catch (cause) { setMessage((cause as Error).message); } finally { setBusy(false); } }
  async function remove() { if (!link) return; setBusy(true); setMessage(null); try { await api.deleteLink(link.id); onDeleted(link.id, displayTitle(link)); } catch (cause) { setMessage(`删除失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); setDeleteArmed(false); } finally { setBusy(false); } }
  const automaticInfo = link ? (link.metadataStatus === 'succeeded' ? '已补充标题、简介或图标。' : link.metadataStatus === 'pending' ? '正在补充，不影响打开链接。' : '未获取，不影响打开链接。') : '保存后会尝试补充标题、简介和图标；无法获取也不影响打开链接。';
  return <DialogFrame title={link ? '编辑链接' : '添加链接'} onClose={onClose}><form onSubmit={save} className="form"><label>网址<input autoFocus required type="text" inputMode="url" value={draft.url} onChange={(event) => update('url', event.target.value)} onBlur={(event) => update('url', normalizeLinkUrl(event.target.value))} placeholder="example.com、https://example.com 或 chrome://..." /></label>{duplicates.length > 0 && <p className="duplicate-note">已存在 {duplicates.length} 个相同网址：{duplicates.map((item) => displayTitle(item)).join('、')}。仍可继续添加。</p>}<div className="quick-link-fields"><label>名称（可选）<input value={draft.displayName ?? ''} onChange={(event) => update('displayName', event.target.value)} placeholder="留空则使用网页标题" /></label><label>保存到标签<select value={targetFolderId} onChange={(event) => setTargetFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label></div><button type="button" className="advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((current) => !current)}>{showAdvanced ? '收起更多选项' : '更多选项'}</button>{showAdvanced && <div className="advanced-fields"><fieldset><legend>内容</legend><label>网页标题（可选）<input value={draft.title ?? ''} onChange={(event) => update('title', event.target.value)} /></label><label>简介（可选）<textarea value={draft.description ?? ''} onChange={(event) => update('description', event.target.value)} /></label></fieldset><fieldset><legend>卡片外观</legend><label>强调色<input type="color" value={draft.appearanceOverride?.accentColor ?? '#4f46e5'} onChange={(event) => updateAppearance('accentColor', event.target.value)} /></label><label>卡片底色<input type="color" value={draft.appearanceOverride?.cardColor ?? '#ffffff'} onChange={(event) => updateAppearance('cardColor', event.target.value)} /></label><label>自定义图标（可选）<input value={draft.appearanceOverride?.icon ?? ''} maxLength={8} onChange={(event) => updateAppearance('icon', event.target.value)} placeholder="例如 📚" /></label><button type="button" className="text-button reset-appearance" onClick={() => update('appearanceOverride', null)}>恢复默认外观</button></fieldset><fieldset><legend>自动信息</legend><label>图标网址（可选）<input type="url" value={draft.faviconUrl ?? ''} onChange={(event) => update('faviconUrl', event.target.value)} /></label><p className={`metadata-note ${link?.metadataStatus ?? 'pending'}`}>{automaticInfo}</p></fieldset></div>}<p className="hint">保存后会自动补齐空白的标题、简介和图标。</p>{deleteArmed && link && <DeleteConfirmation subject={`链接“${displayTitle(link)}”`} detail="删除后将无法恢复。" busy={busy} onCancel={() => setDeleteArmed(false)} onConfirm={() => void remove()} />}{message && <p className="form-error">{message}</p>}<footer>{link && !deleteArmed && <><button type="button" className="text-button" onClick={async () => { setBusy(true); try { onSaved(await api.refreshMetadata(link.id)); } catch (cause) { setMessage((cause as Error).message); } finally { setBusy(false); } }}>重新抓取</button><button type="button" className="danger" onClick={() => setDeleteArmed(true)}>删除链接</button></>}{!deleteArmed && <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>}</footer></form></DialogFrame>;
}

function DeleteConfirmation({ subject, detail, busy, onCancel, onConfirm }: { subject: string; detail: string; busy: boolean; onCancel(): void; onConfirm(): void }) { return <div className="delete-confirm" role="alert"><strong>确认删除{subject}？</strong><span>{detail}</span><div><button type="button" className="quiet-button" onClick={onCancel}>取消</button><button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy ? '删除中…' : '确认删除'}</button></div></div>; }

function FolderDialog({ folder, linkCount, onClose, onSaved, onDeleted }: { folder?: Folder; linkCount: number; onClose(): void; onSaved(folder: Folder): void; onDeleted(id: string, name: string): void }) {
  const [name, setName] = useState(folder?.name ?? ''); const [autoRulesText, setAutoRulesText] = useState(folder?.autoRules.join('\n') ?? ''); const [message, setMessage] = useState<string | null>(null); const [deleteArmed, setDeleteArmed] = useState(false); const [deleting, setDeleting] = useState(false);
  const autoRules = () => [...new Set(autoRulesText.split(/[\n,]+/).map((rule) => rule.trim().toLowerCase()).filter(Boolean))];
  async function remove() { if (!folder) return; setDeleting(true); setMessage(null); try { await api.deleteFolder(folder.id); onDeleted(folder.id, folder.name); } catch (cause) { setMessage(`删除失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); setDeleteArmed(false); } finally { setDeleting(false); } }
  return <DialogFrame title={folder ? '管理标签' : '添加标签'} onClose={onClose}><form className="form" onSubmit={async (event) => { event.preventDefault(); setMessage(null); try { const input = { name, autoRules: autoRules() }; onSaved(folder ? await api.updateFolder(folder.id, input) : await api.createFolder(input)); } catch (cause) { setMessage((cause as Error).message); } }}><label>标签名称<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><fieldset><legend>自动归集规则</legend><label>匹配域名<textarea value={autoRulesText} onChange={(event) => setAutoRulesText(event.target.value)} placeholder={'例如：\n*.github.com\ngithub.com'} /></label><p className="hint">每行或逗号分隔一条。`*.github.com` 会匹配 github.com 及其子域名；保存后会立即归集已有链接。</p></fieldset>{folder && <p className="hint">此标签包含 {linkCount} 个链接。多个标签命中同一网址时，以标签从左到右的顺序为准。</p>}{deleteArmed && folder && <DeleteConfirmation subject={`标签“${folder.name}”`} detail={`其中 ${linkCount} 个链接也会永久删除。`} busy={deleting} onCancel={() => setDeleteArmed(false)} onConfirm={() => void remove()} />}{message && <p className="form-error">{message}</p>}<footer>{folder && !deleteArmed && <button type="button" className="danger" onClick={() => setDeleteArmed(true)}>删除标签</button>}{!deleteArmed && <button className="primary">保存</button>}</footer></form></DialogFrame>;
}

function SettingsDialog({ settings, onClose, onOpenConnection, onSaved }: { settings: Settings; onClose(): void; onOpenConnection(): void; onSaved(settings: Settings): void }) {
  const [draft, setDraft] = useState(settings); const [message, setMessage] = useState<string | null>(null); const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  async function save() { try { onSaved(await api.updateSettings(draft)); } catch (cause) { setMessage((cause as Error).message); } }
  return <DialogFrame title="显示设置" onClose={onClose}><div className="form settings"><fieldset><legend>布局</legend><label>视图<select value={draft.layout} onChange={(event) => patch('layout', event.target.value as Settings['layout'])}><option value="grid">文字卡片</option><option value="list">列表</option></select></label><label>主题<select value={draft.theme} onChange={(event) => patch('theme', event.target.value as Settings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>列数<select value={draft.columnMode} onChange={(event) => patch('columnMode', event.target.value as Settings['columnMode'])}><option value="auto">自动（按可用宽度和卡片宽度）</option><option value="fixed">固定</option></select></label>{draft.columnMode === 'fixed' && <label>固定列数<input type="number" min="1" max="12" value={draft.columns} onChange={(event) => patch('columns', Number(event.target.value))} /></label>}<label>卡片宽度<input type="number" min="175" max="600" value={draft.cardWidth} onChange={(event) => patch('cardWidth', Number(event.target.value))} /></label><label>卡片间距<input type="number" min="4" max="40" value={draft.gap} onChange={(event) => patch('gap', Number(event.target.value))} /></label><label>字体<select value={draft.fontFamily} onChange={(event) => patch('fontFamily', event.target.value)}><option value="system-ui">系统默认</option><option value="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">系统无衬线</option><option value="Georgia, serif">衬线</option><option value="monospace">等宽</option></select></label><label>正文颜色<input type="color" value={draft.textColor || '#202124'} onChange={(event) => patch('textColor', event.target.value)} /></label><label>强调颜色<input type="color" value={draft.accentColor} onChange={(event) => patch('accentColor', event.target.value)} /></label></fieldset><fieldset><legend>显示内容</legend>{([{ key: 'compact', label: '紧凑布局' }, { key: 'showDescription', label: '显示简介' }, { key: 'showClickCount', label: '显示访问次数' }, { key: 'showLastVisited', label: '显示最近访问' }, { key: 'showRecommendations', label: '显示推荐访问' }] as const).map(({ key, label }) => <label className="check" key={key}><input type="checkbox" checked={draft[key]} onChange={(event) => patch(key, event.target.checked)} />{label}</label>)}</fieldset><section className="connection-panel"><div><strong>本机服务</strong><p>服务地址和配对令牌仅在连接异常或重新配对时需要。</p></div><button className="quiet-button" onClick={onOpenConnection}>管理连接</button></section>{message && <p className="form-error">{message}</p>}<footer><button className="primary" onClick={() => void save()}>保存显示设置</button></footer></div></DialogFrame>;
}

function ConnectionDialog({ onClose }: { onClose(): void }) {
  const [connection, setConnection] = useState<ConnectionPreferences>(defaultConnection); const [status, setStatus] = useState<'idle' | 'checking' | 'connected' | 'failed'>('idle'); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void getConnection().then(setConnection); }, []);
  async function verify() { setStatus('checking'); setMessage(null); try { await saveConnection(connection); await api.health(); setStatus('connected'); setMessage('连接正常。返回主页后，创建标签并添加第一个网址即可开始。'); } catch (cause) { setStatus('failed'); setMessage(`无法连接：${cause instanceof Error ? cause.message : '请检查服务是否已启动'}`); } }
  return <DialogFrame title="本机服务连接" onClose={onClose}><div className="form"><p className="hint">通常只需在首次配对、服务地址变更或连接异常时打开这里。</p><label>服务地址<input value={connection.apiBaseUrl} onChange={(event) => setConnection({ ...connection, apiBaseUrl: event.target.value })} /></label><label>配对令牌<input type="password" value={connection.token} onChange={(event) => setConnection({ ...connection, token: event.target.value })} /></label>{message && <p className={`connection-status ${status}`}>{message}</p>}<footer><button className="primary" disabled={status === 'checking'} onClick={() => void verify()}>{status === 'checking' ? '正在验证…' : '保存并验证'}</button></footer></div></DialogFrame>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
