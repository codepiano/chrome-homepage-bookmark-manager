import { displayTitle, displayHost, dateFormat, folderSubtreeIds, LINK_TREE_DRAG_TYPE } from './shared';
import { StrictMode, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, getLastGoodSnapshot, saveLastGoodSnapshot } from './api';
import { buildSmartViews, type SmartView, type SmartViewId } from './smartViews';
import { defaultSettings, type Folder, type Link, type LinkDraft, type Recommendation, type Settings } from './types';
import '@mantine/core/styles.css';
import './styles.css';
import './controls.css';
import { AppProvider, Button, Input, Select, Toast } from './ui';

const TagTree = lazy(() => import('./TagTree'));
const LinkMaintenanceDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.LinkMaintenanceDialog })));
const DuplicateMergeDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.DuplicateMergeDialog })));
const BatchOpenDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.BatchOpenDialog })));
const TrashDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.TrashDialog })));
const VersionsDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.VersionsDialog })));
const LinkDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.LinkDialog })));
const FolderDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.FolderDialog })));
const SettingsDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.SettingsDialog })));
const ConnectionDialog = lazy(() => import('./dialogs').then((module) => ({ default: module.ConnectionDialog })));
type Dialog = { type: 'link'; link?: Link; initial?: Partial<LinkDraft>; deleteArmed?: boolean } | { type: 'folder'; folder?: Folder; parentId?: string | null } | { type: 'settings' } | { type: 'connection' } | { type: 'trash' } | { type: 'versions' } | { type: 'batch-open'; folder: Folder } | { type: 'merge-duplicates'; links: Link[] } | { type: 'maintenance' } | null;
type ViewMode = 'browse' | 'organize';
const cardStyle = (link: Link) => ({
  '--card-accent': link.appearanceOverride?.accentColor ?? 'var(--accent)',
  '--card-background': link.appearanceOverride?.cardColor ?? 'var(--surface)',
} as React.CSSProperties);
const refreshContextMenus = () => { void chrome.runtime.sendMessage({ type: 'refresh-context-menus' }).catch(() => undefined); };
const TAG_TREE_EXPANDED_KEY = 'tagTreeExpandedIds';
const TAG_VIEW_KEY = 'tagViewMode';

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
  return <article style={cardStyle(link)} className={`link-card link-card-open ${link.metadataStatus === 'failed' ? 'has-metadata-action' : ''} ${settings.layout}`}><a className="card-link" href={link.url} aria-label={`打开 ${title}`} onClick={onRecord}><LinkContents link={link} settings={settings} /></a>{link.metadataStatus === 'failed' && <Button type="button" className="retry-metadata" title={link.metadataError ?? '重新抓取标题、简介和图标'} onClick={onRetry}>重新抓取</Button>}</article>;
}

function SmartViewBar({ views, activeId, disabled, onSelect }: { views: SmartView[]; activeId: SmartViewId | null; disabled: boolean; onSelect(id: SmartViewId): void }) {
  return <nav className="smart-views" aria-label="智能视图"><span className="smart-views-label">智能视图</span>{views.map((view) => <Button key={view.id} type="button" className={activeId === view.id ? 'active' : ''} aria-pressed={activeId === view.id} disabled={disabled} onClick={() => onSelect(view.id)}><span>{view.label}</span><strong>{view.links.length}</strong></Button>)}</nav>;
}

function SmartViewCard({ link, folderName, settings, readOnly, onRecord, onRetry, onEdit }: { link: Link; folderName: string; settings: Settings; readOnly: boolean; onRecord(): void; onRetry(): void; onEdit(): void }) {
  const title = displayTitle(link);
  return <article style={cardStyle(link)} className={`link-card smart-view-card ${settings.layout}`}><a className="smart-card-link" href={link.url} aria-label={`打开 ${title}`} onClick={onRecord}><LinkContents link={link} settings={settings} /></a><footer><span title={folderName}>{folderName}</span><div>{link.metadataStatus === 'failed' && !readOnly && <Button type="button" className="card-action" title={link.metadataError ?? '重新抓取标题、简介和图标'} onClick={onRetry}>重新抓取</Button>}{!readOnly && <Button type="button" className="card-action" onClick={onEdit}>编辑</Button>}</div></footer></article>;
}

function SmartViewPanel({ view, folders, settings, readOnly, onRecord, onRetry, onEdit, onMergeDuplicates, onOpenMaintenance }: { view: SmartView; folders: Folder[]; settings: Settings; readOnly: boolean; onRecord(link: Link): void; onRetry(link: Link): void; onEdit(link: Link): void; onMergeDuplicates(links: Link[]): void; onOpenMaintenance(): void }) {
  return <div className="smart-view-panel"><div className="section-heading"><div><h2>{view.label}</h2><p>{view.links.length} 个链接 · {view.description}{readOnly ? ' · 离线快照只读' : ''}</p></div><div className="section-heading-actions">{view.id === 'duplicates' && view.links.length > 1 && !readOnly && <Button type="button" className="primary" onClick={() => onMergeDuplicates(view.links)}>合并重复项</Button>}{view.id === 'healthIssues' && !readOnly && <Button type="button" className="primary" onClick={onOpenMaintenance}>检查与修复</Button>}</div></div>{view.links.length ? <div className={`links ${settings.layout} columns-${settings.columnMode}`}>{view.links.map((link) => <SmartViewCard key={link.id} link={link} folderName={folders.find((folder) => folder.id === link.folderId)?.name ?? '未知标签'} settings={settings} readOnly={readOnly} onRecord={() => onRecord(link)} onRetry={() => onRetry(link)} onEdit={() => onEdit(link)} />)}</div> : <div className="smart-view-empty"><strong>这里暂时是空的</strong><p>{view.emptyMessage}</p></div>}</div>;
}

function SortableTab({ folder, active, disabled = false, onSelect }: { folder: Folder; active: boolean; disabled?: boolean; onSelect(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: folder.id });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="tab-wrap">
    <Button className={`tab ${active ? 'active' : ''}`} disabled={disabled} onClick={onSelect} {...attributes} {...listeners} aria-label={`${folder.name}，可拖动排序`}>{folder.name}</Button>
  </div>;
}

function SortableCard({ link, settings, selectable = false, selected = false, disabled = false, treeMoveIds, onToggle, onOpen, onEdit, onPin }: { link: Link; settings: Settings; selectable?: boolean; selected?: boolean; disabled?: boolean; treeMoveIds?: string[]; onToggle?(): void; onOpen(): void; onEdit(): void; onPin(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: link.id });
  const title = displayTitle(link);
  return <article ref={setNodeRef} style={{ ...cardStyle(link), transform: CSS.Transform.toString(transform), transition }} className={`link-card organize-card ${settings.layout} ${selectable ? 'selectable-card' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}>
    {selectable && <label className="card-select"><Input type="checkbox" checked={selected} disabled={disabled} onChange={onToggle} aria-label={`选择 ${title}`} /><span>选择</span></label>}
    <Button type="button" className="organize-open" disabled={disabled} onClick={onOpen} aria-label={`打开 ${title}`}><LinkContents link={link} settings={settings} /></Button>
    <div className="card-actions"><Button type="button" className="card-action" disabled={disabled} onClick={onEdit}>编辑</Button><Button type="button" className="card-action" disabled={disabled} onClick={onPin}>{link.pinnedAt ? '取消置顶' : '置顶'}</Button>{treeMoveIds && <Button type="button" className="card-action tree-move-handle" draggable={!disabled} disabled={disabled} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(LINK_TREE_DRAG_TYPE, JSON.stringify(treeMoveIds)); }} aria-label={`拖动 ${title} 到标签树归类`}>归类</Button>}<Button type="button" className="card-action drag-handle" disabled={disabled} {...attributes} {...listeners} aria-label={`拖动 ${title} 排序`}>排序</Button></div>
  </article>;
}

function BatchOrganizer({ selectedCount, totalCount, targetFolderId, folders, busy, onToggleAll, onTargetChange, onMove, onCreateFolder }: { selectedCount: number; totalCount: number; targetFolderId: string; folders: Folder[]; busy: boolean; onToggleAll(): void; onTargetChange(id: string): void; onMove(): void; onCreateFolder(): void }) {
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  return <section className="batch-organizer" aria-label="批量整理收集箱" aria-busy={busy}>
    <div className="batch-summary"><strong>{selectedCount ? `已选择 ${selectedCount} 项` : '选择要整理的链接'}</strong><span>{totalCount ? '移动后会从收集箱消失' : '用浏览器工具栏按钮收藏当前页面'}</span></div>
    {totalCount > 0 && <Button type="button" className="quiet-button batch-select-all" disabled={busy} onClick={onToggleAll}>{allSelected ? '取消全选' : '全选'}</Button>}
    {folders.length ? <><label className="batch-target"><span>移动到</span><Select value={targetFolderId} disabled={busy} onChange={(event) => onTargetChange(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label><Button type="button" className="primary batch-move" disabled={!selectedCount || !targetFolderId || busy} onClick={onMove}>{busy ? '正在移动…' : selectedCount ? `移动 ${selectedCount} 项` : '移动所选链接'}</Button></> : <Button type="button" className="primary batch-move" disabled={busy} onClick={onCreateFolder}>先创建目标标签</Button>}
  </section>;
}

function RecommendationStrip({ links, settings, onOpen }: { links: Recommendation[]; settings: Settings; onOpen(link: Link): void }) {
  if (!links.length) return null;
  return <section className="recommendations" aria-label="最近常用"><div className="recommendations-heading"><div><h2>最近常用</h2><p>按近期使用与访问频率排序</p></div></div><div className="highlight-links">{links.slice(0, 6).map((link) => <a key={link.id} style={cardStyle(link)} className="highlight-card" href={link.url} onClick={() => onOpen(link)}><LinkContents link={link} settings={settings} /></a>)}</div></section>;
}

function PinnedStrip({ links, settings, onOpen }: { links: Link[]; settings: Settings; onOpen(link: Link): void }) {
  if (!links.length) return null;
  return <section className="pinned-strip" aria-label="全局置顶"><div className="pinned-heading"><h2>置顶</h2><span>{links.length} 个跨标签入口</span></div><div className="pinned-links">{links.map((link) => <a key={link.id} style={cardStyle(link)} className="pinned-card" href={link.url} onClick={() => onOpen(link)}><LinkContents link={link} settings={settings} /></a>)}</div></section>;
}

type PaletteCommand = { id: string; label: string; detail: string; keywords?: string; run(): void };

function BookmarkSearch({ query, links, folders, commands, onQueryChange, onOpen, onSelectFolder }: { query: string; links: Link[]; folders: Folder[]; commands: PaletteCommand[]; onQueryChange(value: string): void; onOpen(link: Link): void; onSelectFolder(folder: Folder): void }) {
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
  const trimmed = query.trim(); const commandMode = trimmed.startsWith('>'); const normalized = (commandMode ? trimmed.slice(1) : trimmed).trim().toLocaleLowerCase();
  const results = commandMode ? commands.filter((command) => !normalized || `${command.label} ${command.detail} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(normalized)).map((command) => ({ id:`command-${command.id}`, type:'命令', label:command.label, detail:command.detail, run:command.run })).slice(0, 12) : normalized ? [...folders.filter((folder) => folder.name.toLocaleLowerCase().includes(normalized)).map((folder) => ({ id:`folder-${folder.id}`, type:'标签', label:folder.name, detail:`${folder.linkCount ?? 0} 个链接`, run:() => onSelectFolder(folder) })), ...links.filter((link) => [displayTitle(link), link.url, link.description ?? '', folders.find((folder) => folder.id === link.folderId)?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(normalized))).map((link) => ({ id:`link-${link.id}`, type:'链接', label:displayTitle(link), detail:`${folders.find((folder) => folder.id === link.folderId)?.name ?? '未分类'} · ${displayHost(link.url)}`, run:() => onOpen(link) }))].slice(0, 12) : [];
  useEffect(() => { setActiveIndex(0); }, [normalized, commandMode]);
  function runResult(index: number) { const result = results[index] ?? results[0]; if (!result) return; result.run(); onQueryChange(''); inputRef.current?.blur(); }
  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => (current + 1) % results.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => (current - 1 + results.length) % results.length); }
    if (event.key === 'Enter') { event.preventDefault(); runResult(activeIndex); }
  }
  const expanded = Boolean(trimmed);
  return <section className={`bookmark-search ${expanded ? 'has-query' : ''} ${commandMode ? 'command-mode' : ''}`} aria-label="搜索与命令"><label><span className="visually-hidden">搜索书签、标签或执行命令</span><Input ref={inputRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls="bookmark-search-results" aria-activedescendant={results[activeIndex]?.id} value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="搜索书签和标签，输入 > 执行命令" /><kbd>⌘K</kbd></label>{expanded && <div id="bookmark-search-results" className="search-results" role="listbox" aria-label={commandMode ? '命令结果' : '搜索结果'}>{results.length ? results.map((result, index) => <Button id={result.id} key={result.id} type="button" role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => runResult(index)}><span><strong>{result.label}</strong><small>{result.detail}</small></span><span className="search-result-type" aria-hidden="true">{result.type}</span></Button>) : <p>{commandMode ? '没有匹配的命令' : '没有匹配的书签或标签'}</p>}</div>}</section>;
}

function folderPath(folders: Folder[], folderId: string | null) {
  const byId = new Map(folders.map((folder) => [folder.id, folder])); const path: Folder[] = []; const seen = new Set<string>(); let current = folderId ? byId.get(folderId) : undefined;
  while (current && !seen.has(current.id)) { path.unshift(current); seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; }
  return path;
}

function FolderBreadcrumb({ path, onSelect }: { path: Folder[]; onSelect(id: string): void }) {
  if (path.length < 2) return null;
  return <nav className="folder-breadcrumb" aria-label="标签路径">{path.map((folder, index) => <span key={folder.id}><Button type="button" disabled={index === path.length - 1} onClick={() => onSelect(folder.id)}>{folder.name}</Button>{index < path.length - 1 && <i aria-hidden="true">/</i>}</span>)}</nav>;
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
  const [smartViewId, setSmartViewId] = useState<SmartViewId | null>(null);
  const [mode, setMode] = useState<ViewMode>('browse');
  const [tagView, setTagView] = useState<'bar' | 'tree'>('bar');
  const [treeExpandedIds, setTreeExpandedIds] = useState<string[]>([]);
  const [treeStateReady, setTreeStateReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<{ message: string; run(): Promise<void> } | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offlineSnapshot, setOfflineSnapshot] = useState(false);
  const [selectedLinkIds, setSelectedLinkIds] = useState<Set<string>>(() => new Set());
  const [batchTargetId, setBatchTargetId] = useState('');
  const [batchMoving, setBatchMoving] = useState(false);
  const clickRetryQueue = useRef(new Set<string>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const selectedFolderPath = useMemo(() => folderPath(folders, selectedFolderId), [folders, selectedFolderId]);
  const isInbox = selectedFolder?.systemRole === 'inbox';
  const batchTargets = folders.filter((folder) => folder.systemRole !== 'inbox');
  const allLinks = useMemo(() => Object.values(libraryLinks).flat(), [libraryLinks]);
  const pinnedLinks = useMemo(() => allLinks.filter((link) => link.pinnedAt).sort((a,b) => String(b.pinnedAt).localeCompare(String(a.pinnedAt))), [allLinks]);
  const smartViews = useMemo(() => buildSmartViews(allLinks), [allLinks]);
  const activeSmartView = smartViews.find((view) => view.id === smartViewId) ?? null;
  const rootStyle = useMemo(() => ({ '--accent': settings.accentColor, ...(settings.textColor ? { '--text': settings.textColor } : {}), '--card-width': `${settings.cardWidth}px`, '--tag-sidebar-width': `${settings.tagSidebarWidth}px`, '--gap': `${settings.gap}px`, '--columns': String(settings.columns), '--grid-justify': 'start', fontFamily: settings.fontFamily } as React.CSSProperties), [settings]);

  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => { setToast(null); setUndoAction(null); }, 5200); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => { void chrome.storage.local.get([TAG_TREE_EXPANDED_KEY,TAG_VIEW_KEY]).then((value) => { const saved = value[TAG_TREE_EXPANDED_KEY]; setTreeExpandedIds(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []); if(value[TAG_VIEW_KEY]==='tree'||value[TAG_VIEW_KEY]==='bar')setTagView(value[TAG_VIEW_KEY]); }).finally(() => setTreeStateReady(true)); }, []);
  useEffect(() => { if (offlineSnapshot) setMode('browse'); }, [offlineSnapshot]);
  useEffect(() => { setSelectedLinkIds(new Set()); }, [selectedFolderId, smartViewId, mode]);
  useEffect(() => { if (!batchTargets.some((folder) => folder.id === batchTargetId)) setBatchTargetId(batchTargets[0]?.id ?? ''); }, [folders, batchTargetId]);

  async function flushClickRetryQueue() {
    await Promise.all([...clickRetryQueue.current].map(async (id) => { try { await api.click(id); clickRetryQueue.current.delete(id); } catch { /* Retry after the next successful load. */ } }));
  }
  async function refreshTrashCount() { try { const trash = await api.trash(); setTrashCount(trash.folders.length + trash.links.length); } catch { /* Keep the last known count while offline. */ } }
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
      void refreshTrashCount();
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
  async function togglePin(link: Link) { try { const next=await api.pinLink(link.id,!link.pinnedAt); setLinks((items)=>items.map((item)=>item.id===next.id?next:item)); updateLibraryLink(next); setToast(next.pinnedAt?`已置顶“${displayTitle(next)}”`:`已取消置顶“${displayTitle(next)}”`); } catch (cause) { setError(`置顶操作失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); } }
  function toggleSelectedLink(id: string) { setSelectedLinkIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function moveSelectedLinks() {
    const ids = links.filter((link) => selectedLinkIds.has(link.id)).map((link) => link.id);
    if (!ids.length || !batchTargetId) return;
    setBatchMoving(true); setError(null);
    try {
      const { moved } = await api.moveLinks(ids, batchTargetId);
      setLinks((items) => items.filter((item) => !selectedLinkIds.has(item.id)));
      setLibraryLinks((current) => ({
        ...current,
        ...(selectedFolderId ? { [selectedFolderId]: (current[selectedFolderId] ?? []).filter((item) => !selectedLinkIds.has(item.id)) } : {}),
        [batchTargetId]: [...(current[batchTargetId] ?? []).filter((item) => !selectedLinkIds.has(item.id)), ...moved],
      }));
      setFolders((items) => items.map((folder) => folder.id === selectedFolderId ? { ...folder, linkCount: Math.max(0, (folder.linkCount ?? links.length) - moved.length) } : folder.id === batchTargetId ? { ...folder, linkCount: (folder.linkCount ?? 0) + moved.length } : folder));
      setSelectedLinkIds(new Set());
      setToast(`已将 ${moved.length} 个链接移动到“${folders.find((folder) => folder.id === batchTargetId)?.name ?? '目标标签'}”`);
    } catch (cause) { setError(`批量整理失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); }
    finally { setBatchMoving(false); }
  }
  async function moveLinksIntoFolder(ids: string[], folderId: string) {
    if (!ids.length) return;
    setBatchMoving(true); setError(null);
    try {
      const { moved } = await api.moveLinks(ids, folderId);
      setSelectedLinkIds(new Set());
      setToast(`已将 ${moved.length} 个链接归类到“${folders.find((folder) => folder.id === folderId)?.name ?? '目标标签'}”`);
      await load();
    } catch (cause) { setError(`归类失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); }
    finally { setBatchMoving(false); }
  }
  async function openLinkBatch(items: Link[], destination: 'current' | 'window') {
    const unique = [...new Map(items.map((link) => [link.url, link])).values()]; if (!unique.length) return;
    try {
      if (destination === 'window') await chrome.windows.create({ url: unique.map((link) => link.url), focused:true });
      else for (const link of unique) await chrome.tabs.create({ url:link.url, active:false });
      void Promise.allSettled(unique.map((link) => api.click(link.id))).then(() => api.recommendations().then((result) => setRecommendations(result.recommendations))).catch(() => undefined);
      setDialog(null); setToast(`已打开 ${unique.length} 个链接`);
    } catch (cause) { setError(`批量打开失败：${cause instanceof Error ? cause.message : 'Chrome 未允许创建标签页'}`); }
  }
  function deleteFolder(id: string, name: string) { setFolders((items) => { const next = items.filter((item) => item.id !== id && item.parentId !== id); setSelectedFolderId((current) => current === id ? next[0]?.id ?? null : current); return next; }); setLinks((items) => selectedFolderId === id ? [] : items); setLibraryLinks((current) => { const next = { ...current }; delete next[id]; return next; }); setDialog(null); const message = `已将标签“${name}”移入回收站`; setToast(message); setUndoAction({ message, run: async () => { await api.restoreFolder(id); setUndoAction(null); setToast(`已恢复标签“${name}”`); await load(); await refreshTrashCount(); } }); void refreshTrashCount(); void load(); }
  function changeTagView(view:'bar'|'tree'){setTagView(view);void chrome.storage.local.set({[TAG_VIEW_KEY]:view});}

  const selectFolder = (id: string) => { setSmartViewId(null); setSelectedFolderId(id); };
  const flatTabs = mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderFolders(event)}><nav className="tabs organize-tabs" aria-label="书签标签"><SortableContext items={folders.map((folder) => folder.id)} strategy={horizontalListSortingStrategy}>{folders.map((folder) => <SortableTab key={folder.id} folder={folder} active={!smartViewId && folder.id === selectedFolderId} disabled={batchMoving} onSelect={() => selectFolder(folder.id)} />)}</SortableContext><Button className="tab-add" disabled={batchMoving} onClick={() => setDialog({ type: 'folder' })}>添加标签</Button></nav></DndContext> : <nav className="tabs" aria-label="书签标签">{folders.map((folder) => <div className="tab-wrap" key={folder.id}><Button className={`tab ${!smartViewId && folder.id === selectedFolderId ? 'active' : ''}`} onClick={() => selectFolder(folder.id)}>{folder.name}</Button></div>)}</nav>;
  const tabs = !loading && treeStateReady && <><div className="tag-view-switch" aria-label="标签显示方式"><Button type="button" className={tagView === 'bar' ? 'active' : ''} aria-pressed={tagView === 'bar'} onClick={() => changeTagView('bar')}>横栏</Button><Button type="button" className={tagView === 'tree' ? 'active' : ''} aria-pressed={tagView === 'tree'} onClick={() => changeTagView('tree')}>树形</Button></div>{tagView === 'tree' ? <Suspense fallback={<p role="status">正在加载标签树…</p>}><TagTree folders={folders} selectedFolderId={selectedFolderId} side={settings.tagSidebarPosition} width={settings.tagSidebarWidth} expandedIds={treeExpandedIds} disabled={offlineSnapshot || batchMoving} onSelect={selectFolder} onAddChild={(parentId) => setDialog({ type: 'folder', parentId })} onManage={(id) => { const folder = folders.find((item) => item.id === id); if (folder) setDialog({ type: 'folder', folder }); }} onMoveLinks={(ids, folderId) => void moveLinksIntoFolder(ids, folderId)} onSideChange={(side) => { setSettings((current) => ({ ...current, tagSidebarPosition: side })); void api.updateSettings({ tagSidebarPosition: side }).catch(() => undefined); }} onWidthChange={(width) => { setSettings((current) => ({ ...current, tagSidebarWidth: width })); void api.updateSettings({ tagSidebarWidth: width }).catch(() => undefined); }} onExpandedChange={(ids) => { setTreeExpandedIds(ids); void chrome.storage.local.set({ [TAG_TREE_EXPANDED_KEY]: ids }); }} onChanged={() => void load()} /></Suspense> : flatTabs}</>;
  const currentRecommendations = recommendations.filter((recommendation) => !links.some((link) => link.id === recommendation.id));
  const paletteCommands: PaletteCommand[] = [
    ...(!offlineSnapshot ? [{ id:'new-root-folder', label:'新建一级标签', detail:'在标签树根级创建标签', keywords:'创建 文件夹', run:() => setDialog({ type:'folder', parentId:null }) }] : []),
    ...(selectedFolder && !offlineSnapshot ? [{ id:'new-child-folder', label:`在“${selectedFolder.name}”下新建子标签`, detail:'创建当前标签的子级', keywords:'创建 子级', run:() => setDialog({ type:'folder', parentId:selectedFolder.id }) }] : []),
    { id:'toggle-tag-view', label:tagView === 'tree' ? '切换到横栏标签' : '切换到树形标签', detail:'改变标签导航方式', keywords:'布局 视图', run:() => changeTagView(tagView === 'tree' ? 'bar' : 'tree') },
    ...(tagView === 'tree' ? [{ id:'move-tree-side', label:`将标签树移到${settings.tagSidebarPosition === 'left' ? '右侧' : '左侧'}`, detail:'切换侧栏位置', keywords:'左右 侧栏', run:() => { const side = settings.tagSidebarPosition === 'left' ? 'right' : 'left'; setSettings((current) => ({ ...current, tagSidebarPosition:side })); void api.updateSettings({ tagSidebarPosition:side }); } }] : []),
    ...(selectedFolder && folderSubtreeIds(folders, selectedFolder.id).some((id) => (libraryLinks[id] ?? []).length) ? [{ id:'batch-open', label:`批量打开“${selectedFolder.name}”`, detail:'选择当前标签或整个子树', keywords:'全部 子树 窗口', run:() => setDialog({ type:'batch-open', folder:selectedFolder }) }] : []),
    ...(!offlineSnapshot ? [{ id:'toggle-organize', label:mode === 'organize' ? '完成整理' : '进入整理模式', detail:mode === 'organize' ? '返回快速打开模式' : '排序、移动和编辑链接', keywords:'管理 编辑', run:() => setMode(mode === 'organize' ? 'browse' : 'organize') }, { id:'maintenance', label:'检查链接状态', detail:'查找失效、暂不可达和永久重定向', keywords:'健康 坏链接 404 跳转', run:() => setDialog({ type:'maintenance' }) }, { id:'versions', label:'打开版本快照', detail:'创建或恢复本地书签库版本', keywords:'备份 快照 恢复', run:() => setDialog({ type:'versions' }) }, { id:'trash', label:'打开回收站', detail:trashCount ? `${trashCount} 项待恢复` : '回收站为空', keywords:'删除 恢复 撤销', run:() => setDialog({ type:'trash' }) }] : []),
    { id:'settings', label:'打开显示设置', detail:'主题、卡片和布局', keywords:'配置 外观', run:() => setDialog({ type:'settings' }) },
  ];

  return <AppProvider settings={settings}><main className={`app theme-${settings.theme} ${settings.compact ? 'compact' : ''} mode-${mode} ${tagView === 'tree' ? `tree-sidebar-${settings.tagSidebarPosition}` : ''}`} style={rootStyle}>
    <header className="header"><h1>快速访问</h1><BookmarkSearch query={searchQuery} links={allLinks} folders={folders} commands={paletteCommands} onQueryChange={setSearchQuery} onOpen={openLink} onSelectFolder={(folder) => selectFolder(folder.id)} /><div className="header-actions"><Button className="quiet-button" disabled={batchMoving || offlineSnapshot} onClick={() => setDialog({ type: 'versions' })}>版本</Button><Button className="quiet-button" disabled={batchMoving || offlineSnapshot} onClick={() => setDialog({ type: 'trash' })}>回收站{trashCount ? ` ${trashCount}` : ''}</Button><Button className="quiet-button" disabled={batchMoving} onClick={() => setDialog({ type: 'settings' })}>设置</Button>{!offlineSnapshot && <Button className={mode === 'organize' ? 'primary' : 'quiet-button'} disabled={batchMoving} onClick={() => { setSmartViewId(null); setMode((current) => current === 'browse' ? 'organize' : 'browse'); }}>{mode === 'organize' ? '完成整理' : !smartViewId && isInbox && links.length ? '整理收集箱' : '整理书签'}</Button>}</div></header>
    {error && <aside className="connection-error" role="alert"><span>无法连接本机服务：{error}{offlineSnapshot ? '。正在显示上次成功同步的只读快照。' : ''}</span><Button onClick={() => void load()}>重试</Button><Button onClick={() => setDialog({ type: 'connection' })}>检查连接</Button></aside>}
    {tabs}
    {!loading && treeStateReady && <SmartViewBar views={smartViews} activeId={smartViewId} disabled={batchMoving} onSelect={(id) => { setSmartViewId(id); setMode('browse'); }} />}
    {!loading && treeStateReady && !activeSmartView && <PinnedStrip links={pinnedLinks} settings={settings} onOpen={recordLinkClick} />}
    <section className="content" aria-busy={loading || !treeStateReady}>{loading || !treeStateReady ? <p className="state">正在连接本机书签库…</p> : activeSmartView ? <SmartViewPanel view={activeSmartView} folders={folders} settings={settings} readOnly={offlineSnapshot} onRecord={recordLinkClick} onRetry={(link) => void retryMetadata(link)} onEdit={(link) => setDialog({ type: 'link', link })} onMergeDuplicates={(items) => setDialog({ type:'merge-duplicates', links:items })} onOpenMaintenance={() => setDialog({ type:'maintenance' })} /> : !selectedFolder ? <Empty onAdd={() => setDialog({ type: 'folder' })} /> : <>
      <div className="section-heading"><div><FolderBreadcrumb path={selectedFolderPath} onSelect={selectFolder} /><h2>{selectedFolder.name}</h2><p>{links.length} 个{isInbox ? '待整理' : '链接'}{offlineSnapshot ? ' · 离线快照只读' : mode === 'organize' ? isInbox ? ' · 选择后批量移动，也可逐项编辑' : tagView === 'tree' ? ' · 可排序，也可拖到标签树归类' : ' · 可拖动标签或链接排序' : isInbox ? ' · 点击“整理收集箱”开始归类' : ''}</p></div><div className="section-heading-actions"><Button className="text-button" disabled={batchMoving || !folderSubtreeIds(folders, selectedFolder.id).some((id) => (libraryLinks[id] ?? []).length)} onClick={() => setDialog({ type: 'batch-open', folder: selectedFolder })}>批量打开</Button>{!offlineSnapshot && <Button className="text-button" disabled={batchMoving} onClick={() => setDialog({ type: 'folder', folder: selectedFolder })}>管理此标签</Button>}</div></div>
      {mode === 'organize' && !offlineSnapshot && isInbox && <BatchOrganizer selectedCount={selectedLinkIds.size} totalCount={links.length} targetFolderId={batchTargetId} folders={batchTargets} busy={batchMoving} onToggleAll={() => setSelectedLinkIds((current) => current.size === links.length ? new Set() : new Set(links.map((link) => link.id)))} onTargetChange={setBatchTargetId} onMove={() => void moveSelectedLinks()} onCreateFolder={() => setDialog({ type: 'folder' })} />}
      {mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderLinks(event)}><SortableContext items={links.map((link) => link.id)} strategy={rectSortingStrategy}><div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <SortableCard key={link.id} link={link} settings={settings} selectable={isInbox} selected={selectedLinkIds.has(link.id)} disabled={isInbox && batchMoving} treeMoveIds={tagView === 'tree' ? selectedLinkIds.has(link.id) && selectedLinkIds.size ? [...selectedLinkIds] : [link.id] : undefined} onToggle={() => toggleSelectedLink(link.id)} onOpen={() => openLink(link)} onEdit={() => setDialog({ type: 'link', link })} onPin={() => void togglePin(link)} />)}<AddCard folderName={selectedFolder.name} empty={links.length === 0} disabled={batchMoving} onClick={() => setDialog({ type: 'link' })} /></div></SortableContext></DndContext> : <><div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <BrowseCard key={link.id} link={link} settings={settings} onRecord={() => recordLinkClick(link)} onRetry={() => void retryMetadata(link)} />)}{!offlineSnapshot && <AddCard folderName={selectedFolder.name} empty={links.length === 0} onClick={() => setDialog({ type: 'link' })} />}</div>{!offlineSnapshot && settings.showRecommendations && <RecommendationStrip links={currentRecommendations} settings={settings} onOpen={recordLinkClick} />}</>}
    </>}</section>
    {toast && <Toast action={undoAction?.message === toast ? '撤销' : undefined} onAction={undoAction?.message === toast ? () => { void undoAction.run().catch((cause) => setError(`恢复失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`)); } : undefined}>{toast}</Toast>}
    <Suspense fallback={<p role="status">正在加载面板…</p>}>{dialog?.type === 'link' && (dialog.link?.folderId ?? selectedFolderId) && <LinkDialog link={dialog.link} initial={dialog.initial} initialDeleteArmed={dialog.deleteArmed} folderId={(dialog.link?.folderId ?? selectedFolderId)!} folders={folders} onClose={() => setDialog(null)} onSaved={(next) => { updateLibraryLink(next, dialog.link?.folderId); setLinks((items) => { const exists = items.some((item) => item.id === next.id); if (next.folderId !== selectedFolderId) return exists ? items.filter((item) => item.id !== next.id) : items; return exists ? items.map((item) => item.id === next.id ? next : item) : [...items, next]; }); setDialog(null); setToast(dialog.link ? '链接已更新' : '链接已添加'); }} onDeleted={(id, name) => { setLinks((items) => items.filter((item) => item.id !== id)); setLibraryLinks((current) => Object.fromEntries(Object.entries(current).map(([folderId, items]) => [folderId, items.filter((item) => item.id !== id)]))); setDialog(null); const message = `已将链接“${name}”移入回收站`; setToast(message); setUndoAction({ message, run: async () => { await api.restoreLink(id); setUndoAction(null); setToast(`已恢复链接“${name}”`); await load(); await refreshTrashCount(); } }); void refreshTrashCount(); }} />}
    {dialog?.type === 'folder' && <FolderDialog folder={dialog.folder} parentId={dialog.parentId} linkCount={dialog.folder?.id === selectedFolderId ? links.length : dialog.folder?.linkCount ?? 0} onClose={() => setDialog(null)} onSaved={(next) => { setFolders((items) => dialog.folder ? items.map((item) => item.id === next.id ? next : item) : [...items, next]); refreshContextMenus(); setSelectedFolderId(next.id); setDialog(null); const moved = (next as Folder & { autoCollected?: number }).autoCollected ?? 0; setToast(dialog.folder ? moved ? `标签已更新，已自动归集 ${moved} 个链接` : '标签已更新' : '标签已添加'); if (!dialog.folder && dialog.parentId) void api.moveFolder(next.id, dialog.parentId, 0).finally(() => void load()); else void load(); }} onDeleted={(id, name) => { deleteFolder(id, name); refreshContextMenus(); }} />}
    {dialog?.type === 'batch-open' && <BatchOpenDialog folder={dialog.folder} folders={folders} linksByFolder={libraryLinks} onClose={() => setDialog(null)} onOpen={(items, destination) => void openLinkBatch(items, destination)} />}
    {dialog?.type === 'merge-duplicates' && <DuplicateMergeDialog links={dialog.links} folders={folders} onClose={() => setDialog(null)} onMerged={async (count) => { setDialog(null); setToast(`已合并 ${count} 个重复链接，其余记录已进入回收站`); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'maintenance' && <LinkMaintenanceDialog links={allLinks} folders={folders} onClose={() => setDialog(null)} onChanged={async () => { await load(); }} />}
    {dialog?.type === 'settings' && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onOpenConnection={() => setDialog({ type: 'connection' })} onSaved={(next) => { setSettings(next); setDialog(null); setToast('显示设置已保存'); }} />}
    {dialog?.type === 'trash' && <TrashDialog onClose={() => setDialog(null)} onRestored={async (message) => { setToast(message); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'versions' && <VersionsDialog onClose={() => setDialog(null)} onRestored={async (label) => { setDialog(null); setToast(`已恢复版本“${label}”`); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'connection' && <ConnectionDialog onClose={() => setDialog(null)} />}
    </Suspense>
  </main></AppProvider>;
}

function AddCard({ folderName, empty, disabled = false, onClick }: { folderName: string; empty: boolean; disabled?: boolean; onClick(): void }) { return <Button className="add-card" disabled={disabled} onClick={onClick} aria-label={`在${folderName}中添加链接`}><strong>添加链接</strong><small>{empty ? '从第一个网址开始' : `添加到“${folderName}”`}</small></Button>; }
function Empty({ onAdd }: { onAdd(): void }) { return <div className="empty"><h2>从第一个标签开始</h2><ol className="starter-steps"><li>创建标签，例如“工作”或“常用”</li><li>添加第一个网址，可填写自己的标题和简介</li><li>以后打开新标签页，直接点击卡片访问</li></ol><Button className="primary" onClick={onAdd}>创建第一个标签</Button></div>; }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
