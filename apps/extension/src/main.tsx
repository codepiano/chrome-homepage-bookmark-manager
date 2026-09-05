import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StaticTreeDataProvider, Tree, UncontrolledTreeEnvironment, createDefaultRenderers, type DraggingPosition, type TreeEnvironmentRef, type TreeItem } from 'react-complex-tree';
import { getDomain, getSubdomain } from 'tldts';
import { api, defaultConnection, getConnection, getLastGoodSnapshot, saveConnection, saveLastGoodSnapshot, type ConnectionPreferences } from './api';
import { buildSmartViews, type SmartView, type SmartViewId } from './smartViews';
import { defaultSettings, type BrowserHistoryPage, type Folder, type LibrarySnapshotVersion, type Link, type LinkAppearance, type LinkDraft, type Recommendation, type Settings, type TrashSnapshot } from './types';
import './styles.css';

type Dialog = { type: 'link'; link?: Link; initial?: Partial<LinkDraft>; deleteArmed?: boolean } | { type: 'folder'; folder?: Folder; parentId?: string | null } | { type: 'settings' } | { type: 'connection' } | { type: 'trash' } | { type: 'versions' } | { type: 'batch-open'; folder: Folder } | { type: 'merge-duplicates'; links: Link[] } | { type: 'maintenance' } | null;
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
const refreshContextMenus = () => { void chrome.runtime.sendMessage({ type: 'refresh-context-menus' }).catch(() => undefined); };
const LINK_TREE_DRAG_TYPE = 'application/x-local-speed-dial-link-ids';
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
  return <article style={cardStyle(link)} className={`link-card link-card-open ${link.metadataStatus === 'failed' ? 'has-metadata-action' : ''} ${settings.layout}`}><a className="card-link" href={link.url} aria-label={`打开 ${title}`} onClick={onRecord}><LinkContents link={link} settings={settings} /></a>{link.metadataStatus === 'failed' && <button type="button" className="retry-metadata" title={link.metadataError ?? '重新抓取标题、简介和图标'} onClick={onRetry}>重新抓取</button>}</article>;
}

function SmartViewBar({ views, activeId, disabled, onSelect }: { views: SmartView[]; activeId: SmartViewId | null; disabled: boolean; onSelect(id: SmartViewId): void }) {
  return <nav className="smart-views" aria-label="智能视图"><span className="smart-views-label">智能视图</span>{views.map((view) => <button key={view.id} type="button" className={activeId === view.id ? 'active' : ''} aria-pressed={activeId === view.id} disabled={disabled} onClick={() => onSelect(view.id)}><span>{view.label}</span><strong>{view.links.length}</strong></button>)}</nav>;
}

function SmartViewCard({ link, folderName, settings, readOnly, onRecord, onRetry, onEdit }: { link: Link; folderName: string; settings: Settings; readOnly: boolean; onRecord(): void; onRetry(): void; onEdit(): void }) {
  const title = displayTitle(link);
  return <article style={cardStyle(link)} className={`link-card smart-view-card ${settings.layout}`}><a className="smart-card-link" href={link.url} aria-label={`打开 ${title}`} onClick={onRecord}><LinkContents link={link} settings={settings} /></a><footer><span title={folderName}>{folderName}</span><div>{link.metadataStatus === 'failed' && !readOnly && <button type="button" className="card-action" title={link.metadataError ?? '重新抓取标题、简介和图标'} onClick={onRetry}>重新抓取</button>}{!readOnly && <button type="button" className="card-action" onClick={onEdit}>编辑</button>}</div></footer></article>;
}

function SmartViewPanel({ view, folders, settings, readOnly, onRecord, onRetry, onEdit, onMergeDuplicates, onOpenMaintenance }: { view: SmartView; folders: Folder[]; settings: Settings; readOnly: boolean; onRecord(link: Link): void; onRetry(link: Link): void; onEdit(link: Link): void; onMergeDuplicates(links: Link[]): void; onOpenMaintenance(): void }) {
  return <div className="smart-view-panel"><div className="section-heading"><div><h2>{view.label}</h2><p>{view.links.length} 个链接 · {view.description}{readOnly ? ' · 离线快照只读' : ''}</p></div><div className="section-heading-actions">{view.id === 'duplicates' && view.links.length > 1 && !readOnly && <button type="button" className="primary" onClick={() => onMergeDuplicates(view.links)}>合并重复项</button>}{view.id === 'healthIssues' && !readOnly && <button type="button" className="primary" onClick={onOpenMaintenance}>检查与修复</button>}</div></div>{view.links.length ? <div className={`links ${settings.layout} columns-${settings.columnMode}`}>{view.links.map((link) => <SmartViewCard key={link.id} link={link} folderName={folders.find((folder) => folder.id === link.folderId)?.name ?? '未知标签'} settings={settings} readOnly={readOnly} onRecord={() => onRecord(link)} onRetry={() => onRetry(link)} onEdit={() => onEdit(link)} />)}</div> : <div className="smart-view-empty"><strong>这里暂时是空的</strong><p>{view.emptyMessage}</p></div>}</div>;
}

function SortableTab({ folder, active, disabled = false, onSelect }: { folder: Folder; active: boolean; disabled?: boolean; onSelect(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: folder.id });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="tab-wrap">
    <button className={`tab ${active ? 'active' : ''}`} disabled={disabled} onClick={onSelect} {...attributes} {...listeners} aria-label={`${folder.name}，可拖动排序`}>{folder.name}</button>
  </div>;
}

function SortableCard({ link, settings, selectable = false, selected = false, disabled = false, treeMoveIds, onToggle, onOpen, onEdit, onPin }: { link: Link; settings: Settings; selectable?: boolean; selected?: boolean; disabled?: boolean; treeMoveIds?: string[]; onToggle?(): void; onOpen(): void; onEdit(): void; onPin(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: link.id });
  const title = displayTitle(link);
  return <article ref={setNodeRef} style={{ ...cardStyle(link), transform: CSS.Transform.toString(transform), transition }} className={`link-card organize-card ${settings.layout} ${selectable ? 'selectable-card' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}>
    {selectable && <label className="card-select"><input type="checkbox" checked={selected} disabled={disabled} onChange={onToggle} aria-label={`选择 ${title}`} /><span>选择</span></label>}
    <button type="button" className="organize-open" disabled={disabled} onClick={onOpen} aria-label={`打开 ${title}`}><LinkContents link={link} settings={settings} /></button>
    <div className="card-actions"><button type="button" className="card-action" disabled={disabled} onClick={onEdit}>编辑</button><button type="button" className="card-action" disabled={disabled} onClick={onPin}>{link.pinnedAt ? '取消置顶' : '置顶'}</button>{treeMoveIds && <button type="button" className="card-action tree-move-handle" draggable={!disabled} disabled={disabled} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(LINK_TREE_DRAG_TYPE, JSON.stringify(treeMoveIds)); }} aria-label={`拖动 ${title} 到标签树归类`}>归类</button>}<button type="button" className="card-action drag-handle" disabled={disabled} {...attributes} {...listeners} aria-label={`拖动 ${title} 排序`}>排序</button></div>
  </article>;
}

function BatchOrganizer({ selectedCount, totalCount, targetFolderId, folders, busy, onToggleAll, onTargetChange, onMove, onCreateFolder }: { selectedCount: number; totalCount: number; targetFolderId: string; folders: Folder[]; busy: boolean; onToggleAll(): void; onTargetChange(id: string): void; onMove(): void; onCreateFolder(): void }) {
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  return <section className="batch-organizer" aria-label="批量整理收集箱" aria-busy={busy}>
    <div className="batch-summary"><strong>{selectedCount ? `已选择 ${selectedCount} 项` : '选择要整理的链接'}</strong><span>{totalCount ? '移动后会从收集箱消失' : '用浏览器工具栏按钮收藏当前页面'}</span></div>
    {totalCount > 0 && <button type="button" className="quiet-button batch-select-all" disabled={busy} onClick={onToggleAll}>{allSelected ? '取消全选' : '全选'}</button>}
    {folders.length ? <><label className="batch-target"><span>移动到</span><select value={targetFolderId} disabled={busy} onChange={(event) => onTargetChange(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><button type="button" className="primary batch-move" disabled={!selectedCount || !targetFolderId || busy} onClick={onMove}>{busy ? '正在移动…' : selectedCount ? `移动 ${selectedCount} 项` : '移动所选链接'}</button></> : <button type="button" className="primary batch-move" disabled={busy} onClick={onCreateFolder}>先创建目标标签</button>}
  </section>;
}

function Toast({ children, action, onAction }: { children: React.ReactNode; action?: string; onAction?(): void }) { return <div className="toast" role="status"><span>{children}</span>{action && onAction && <button type="button" onClick={onAction}>{action}</button>}</div>; }

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
  return <section className={`bookmark-search ${expanded ? 'has-query' : ''} ${commandMode ? 'command-mode' : ''}`} aria-label="搜索与命令"><label><span className="visually-hidden">搜索书签、标签或执行命令</span><input ref={inputRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls="bookmark-search-results" aria-activedescendant={results[activeIndex]?.id} value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="搜索书签和标签，输入 > 执行命令" /><kbd>⌘K</kbd></label>{expanded && <div id="bookmark-search-results" className="search-results" role="listbox" aria-label={commandMode ? '命令结果' : '搜索结果'}>{results.length ? results.map((result, index) => <button id={result.id} key={result.id} type="button" role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => runResult(index)}><span><strong>{result.label}</strong><small>{result.detail}</small></span><span className="search-result-type" aria-hidden="true">{result.type}</span></button>) : <p>{commandMode ? '没有匹配的命令' : '没有匹配的书签或标签'}</p>}</div>}</section>;
}

function TagTree({ folders, selectedFolderId, side, width, expandedIds, disabled, onSelect, onAddChild, onManage, onMoveLinks, onSideChange, onWidthChange, onExpandedChange, onChanged }: { folders: Folder[]; selectedFolderId: string | null; side: 'left' | 'right'; width: number; expandedIds: string[]; disabled?: boolean; onSelect(id: string): void; onAddChild(parentId: string | null): void; onManage(id: string): void; onMoveLinks(ids: string[], folderId: string): void; onSideChange(side: 'left' | 'right'): void; onWidthChange(width: number): void; onExpandedChange(ids: string[]): void; onChanged(): void }) {
  const [treeQuery,setTreeQuery]=useState('');
  const treeModel = useMemo(() => {
    const childrenByParent = new Map<string | null, string[]>();
    for (const folder of folders) { const siblings = childrenByParent.get(folder.parentId) ?? []; siblings.push(folder.id); childrenByParent.set(folder.parentId, siblings); }
    const byId=new Map(folders.map((folder)=>[folder.id,folder])); const counts=new Map<string,{direct:number;subtree:number}>(); const count=(id:string,seen=new Set<string>()):number=>{if(seen.has(id))return 0;seen.add(id);const folder=byId.get(id);if(!folder)return 0;const direct=folder.linkCount??0;const subtree=direct+(childrenByParent.get(id)??[]).reduce((sum,child)=>sum+count(child,new Set(seen)),0);counts.set(id,{direct,subtree});return subtree;}; for(const folder of folders)count(folder.id);
    const normalized=treeQuery.trim().toLocaleLowerCase(); const matches=new Set(normalized?folders.filter((folder)=>folder.name.toLocaleLowerCase().includes(normalized)).map((folder)=>folder.id):folders.map((folder)=>folder.id)); const visible=new Set(matches); if(normalized)for(const id of matches){let current=byId.get(id);while(current?.parentId){visible.add(current.parentId);current=byId.get(current.parentId);}}
    const tree: Record<string, TreeItem<Folder | null>> = { root: { index: 'root', isFolder: true, children:(childrenByParent.get(null)??[]).filter((id)=>visible.has(id)), data: null } };
    for (const folder of folders) if(visible.has(folder.id)) tree[folder.id] = { index: folder.id, isFolder: true, children:(childrenByParent.get(folder.id)??[]).filter((id)=>visible.has(id)), data: folder, canMove: folder.systemRole !== 'inbox', canRename: folder.systemRole !== 'inbox' };
    const parentIds=folders.filter((folder)=>(childrenByParent.get(folder.id)??[]).length>0).map((folder)=>folder.id); const searchExpanded=normalized?parentIds.filter((id)=>visible.has(id)):expandedIds;
    return {items:tree,counts,parentIds,searchExpanded,matchCount:matches.size};
  }, [folders,treeQuery,expandedIds]);
  const provider = useMemo(() => new StaticTreeDataProvider(treeModel.items, (item, name) => ({ ...item, data: item.data ? { ...item.data, name } : item.data })), [treeModel.items]);
  const renderers = useMemo(() => createDefaultRenderers(18), []);
  const selected = selectedFolderId ? [selectedFolderId] : [];
  async function move(itemsToMove: TreeItem<Folder | null>[], target: DraggingPosition) {
    const dragged = itemsToMove.map((item) => item.data).filter((folder): folder is Folder => Boolean(folder));
    if (!dragged.length || disabled) return;
    let parentId: string | null = null; let index = folders.filter((folder) => folder.parentId === null).length;
    if (target.targetType === 'item') { parentId = String(target.targetItem); index = folders.filter((folder) => folder.parentId === parentId).length; }
    else if (target.targetType === 'between-items') { parentId = target.parentItem === 'root' ? null : String(target.parentItem); index = target.childIndex + (target.linePosition === 'bottom' ? 1 : 0); }
    for (const folder of dragged) { if (folder.parentId === parentId && folder.position === index) continue; await api.moveFolder(folder.id, parentId, index); index += 1; }
    onChanged();
  }
  async function rename(item: TreeItem<Folder | null>, name: string) {
    if (!item.data || !name.trim()) return;
    await api.updateFolder(item.data.id, { name: name.trim(), autoRules: item.data.autoRules, parentId: item.data.parentId });
    onChanged();
  }
  function startResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault(); const startX = event.clientX; const startWidth = width; const app = event.currentTarget.closest('.app') as HTMLElement | null; let nextWidth = startWidth;
    const move = (pointer: PointerEvent) => { const delta = side === 'left' ? pointer.clientX - startX : startX - pointer.clientX; nextWidth = Math.max(220, Math.min(480, Math.round(startWidth + delta))); app?.style.setProperty('--tag-sidebar-width', `${nextWidth}px`); };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); document.body.classList.remove('resizing-tag-tree'); onWidthChange(nextWidth); };
    document.body.classList.add('resizing-tag-tree'); window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once:true }); window.addEventListener('pointercancel', stop, { once:true });
  }
  return <aside className={`tag-tree-panel tag-tree-${side}`} aria-label="树形标签"><button type="button" className="tag-tree-resize-handle" aria-label="调整标签树宽度" title="拖动调整侧栏宽度" onPointerDown={startResize} /><div className="tag-tree-toolbar"><div className="tag-tree-toolbar-head"><strong>标签树</strong><div className="tag-tree-position" aria-label="侧栏位置"><button type="button" className={side === 'left' ? 'active' : ''} aria-pressed={side === 'left'} onClick={() => onSideChange('left')}>左侧</button><button type="button" className={side === 'right' ? 'active' : ''} aria-pressed={side === 'right'} onClick={() => onSideChange('right')}>右侧</button></div></div><div className="tag-tree-actions"><button type="button" className="quiet-button" disabled={disabled} onClick={() => onAddChild(null)}>新建一级</button><button type="button" className="quiet-button" disabled={disabled || !selectedFolderId} onClick={() => onAddChild(selectedFolderId)}>新建子级</button><button type="button" className="quiet-button" disabled={disabled || !selectedFolderId} onClick={() => selectedFolderId && onManage(selectedFolderId)}>管理所选</button></div><div className="tag-tree-search"><input type="search" value={treeQuery} onChange={(event)=>setTreeQuery(event.target.value)} placeholder="搜索标签" aria-label="搜索标签树"/><button type="button" title="全部展开" aria-label="全部展开" onClick={()=>onExpandedChange(treeModel.parentIds)}>展开</button><button type="button" title="全部折叠" aria-label="全部折叠" onClick={()=>onExpandedChange([])}>折叠</button></div><p className="tag-tree-hint">{treeQuery.trim()?`找到 ${treeModel.matchCount} 个标签`:'将卡片的“归类”拖到目标标签'}</p></div><UncontrolledTreeEnvironment key={`${treeQuery}|${treeModel.searchExpanded.join(',')}`} {...renderers} dataProvider={provider} getItemTitle={(item) => item.data?.name ?? '标签'} viewState={{ 'tag-tree': { selectedItems: selected, expandedItems: treeModel.searchExpanded } }} canDragAndDrop={!disabled} canDropOnFolder={!disabled} canReorderItems={!disabled} canRename={!disabled} onExpandItem={(item) => { if(!treeQuery.trim())onExpandedChange([...new Set([...expandedIds, String(item.index)])]); }} onCollapseItem={(item) => { if(!treeQuery.trim())onExpandedChange(expandedIds.filter((id) => id !== String(item.index))); }} onSelectItems={(ids) => { const id = String(ids[0] ?? ''); if (id && id !== 'root') onSelect(id); }} onPrimaryAction={(item) => { if (item.data) onSelect(item.data.id); }} onRenameItem={(item, name) => void rename(item, name)} onDrop={(itemsToMove, target) => void move(itemsToMove, target)} renderItemTitle={({item,title})=>item.data?<span className="tag-tree-node-title"><span>{title}</span><small>{treeModel.counts.get(item.data.id)?.direct??0} / {treeModel.counts.get(item.data.id)?.subtree??0}</small></span>:title} renderItem={(props) => { const folder = props.item.data; if (!folder || disabled) return renderers.renderItem(props); const containerProps = { ...props.context.itemContainerWithChildrenProps, onDragOver: (event: React.DragEvent<HTMLElement>) => { if (!event.dataTransfer.types.includes(LINK_TREE_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; event.currentTarget.classList.add('link-drop-target'); }, onDragLeave: (event: React.DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.classList.remove('link-drop-target'); }, onDrop: (event: React.DragEvent<HTMLElement>) => { event.preventDefault(); event.currentTarget.classList.remove('link-drop-target'); try { const ids = JSON.parse(event.dataTransfer.getData(LINK_TREE_DRAG_TYPE)) as string[]; if (Array.isArray(ids) && ids.length) onMoveLinks(ids, folder.id); } catch { /* Ignore unrelated drag payloads. */ } } }; return renderers.renderItem({ ...props, context: { ...props.context, itemContainerWithChildrenProps: containerProps } }); }}><Tree treeId="tag-tree" rootItem="root" treeLabel="标签树" /></UncontrolledTreeEnvironment>{treeQuery.trim()&&treeModel.matchCount===0&&<p className="tag-tree-empty">没有匹配的标签。</p>}</aside>;
}

function folderPath(folders: Folder[], folderId: string | null) {
  const byId = new Map(folders.map((folder) => [folder.id, folder])); const path: Folder[] = []; const seen = new Set<string>(); let current = folderId ? byId.get(folderId) : undefined;
  while (current && !seen.has(current.id)) { path.unshift(current); seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; }
  return path;
}

function folderSubtreeIds(folders: Folder[], rootId: string) {
  const children = new Map<string, string[]>(); for (const folder of folders) { if (!folder.parentId) continue; const ids = children.get(folder.parentId) ?? []; ids.push(folder.id); children.set(folder.parentId, ids); }
  const result: string[] = []; const queue = [rootId]; const seen = new Set<string>();
  while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); result.push(id); queue.push(...(children.get(id) ?? [])); }
  return result;
}

function FolderBreadcrumb({ path, onSelect }: { path: Folder[]; onSelect(id: string): void }) {
  if (path.length < 2) return null;
  return <nav className="folder-breadcrumb" aria-label="标签路径">{path.map((folder, index) => <span key={folder.id}><button type="button" disabled={index === path.length - 1} onClick={() => onSelect(folder.id)}>{folder.name}</button>{index < path.length - 1 && <i aria-hidden="true">/</i>}</span>)}</nav>;
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
  const flatTabs = mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderFolders(event)}><nav className="tabs organize-tabs" aria-label="书签标签"><SortableContext items={folders.map((folder) => folder.id)} strategy={horizontalListSortingStrategy}>{folders.map((folder) => <SortableTab key={folder.id} folder={folder} active={!smartViewId && folder.id === selectedFolderId} disabled={batchMoving} onSelect={() => selectFolder(folder.id)} />)}</SortableContext><button className="tab-add" disabled={batchMoving} onClick={() => setDialog({ type: 'folder' })}>添加标签</button></nav></DndContext> : <nav className="tabs" aria-label="书签标签">{folders.map((folder) => <div className="tab-wrap" key={folder.id}><button className={`tab ${!smartViewId && folder.id === selectedFolderId ? 'active' : ''}`} onClick={() => selectFolder(folder.id)}>{folder.name}</button></div>)}</nav>;
  const tabs = !loading && treeStateReady && <><div className="tag-view-switch" aria-label="标签显示方式"><button type="button" className={tagView === 'bar' ? 'active' : ''} aria-pressed={tagView === 'bar'} onClick={() => changeTagView('bar')}>横栏</button><button type="button" className={tagView === 'tree' ? 'active' : ''} aria-pressed={tagView === 'tree'} onClick={() => changeTagView('tree')}>树形</button></div>{tagView === 'tree' ? <TagTree folders={folders} selectedFolderId={selectedFolderId} side={settings.tagSidebarPosition} width={settings.tagSidebarWidth} expandedIds={treeExpandedIds} disabled={offlineSnapshot || batchMoving} onSelect={selectFolder} onAddChild={(parentId) => setDialog({ type: 'folder', parentId })} onManage={(id) => { const folder = folders.find((item) => item.id === id); if (folder) setDialog({ type: 'folder', folder }); }} onMoveLinks={(ids, folderId) => void moveLinksIntoFolder(ids, folderId)} onSideChange={(side) => { setSettings((current) => ({ ...current, tagSidebarPosition: side })); void api.updateSettings({ tagSidebarPosition: side }).catch(() => undefined); }} onWidthChange={(width) => { setSettings((current) => ({ ...current, tagSidebarWidth: width })); void api.updateSettings({ tagSidebarWidth: width }).catch(() => undefined); }} onExpandedChange={(ids) => { setTreeExpandedIds(ids); void chrome.storage.local.set({ [TAG_TREE_EXPANDED_KEY]: ids }); }} onChanged={() => void load()} /> : flatTabs}</>;
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

  return <main className={`app theme-${settings.theme} ${settings.compact ? 'compact' : ''} mode-${mode} ${tagView === 'tree' ? `tree-sidebar-${settings.tagSidebarPosition}` : ''}`} style={rootStyle}>
    <header className="header"><h1>快速访问</h1><BookmarkSearch query={searchQuery} links={allLinks} folders={folders} commands={paletteCommands} onQueryChange={setSearchQuery} onOpen={openLink} onSelectFolder={(folder) => selectFolder(folder.id)} /><div className="header-actions"><button className="quiet-button" disabled={batchMoving || offlineSnapshot} onClick={() => setDialog({ type: 'versions' })}>版本</button><button className="quiet-button" disabled={batchMoving || offlineSnapshot} onClick={() => setDialog({ type: 'trash' })}>回收站{trashCount ? ` ${trashCount}` : ''}</button><button className="quiet-button" disabled={batchMoving} onClick={() => setDialog({ type: 'settings' })}>设置</button>{!offlineSnapshot && <button className={mode === 'organize' ? 'primary' : 'quiet-button'} disabled={batchMoving} onClick={() => { setSmartViewId(null); setMode((current) => current === 'browse' ? 'organize' : 'browse'); }}>{mode === 'organize' ? '完成整理' : !smartViewId && isInbox && links.length ? '整理收集箱' : '整理书签'}</button>}</div></header>
    {error && <aside className="connection-error" role="alert"><span>无法连接本机服务：{error}{offlineSnapshot ? '。正在显示上次成功同步的只读快照。' : ''}</span><button onClick={() => void load()}>重试</button><button onClick={() => setDialog({ type: 'connection' })}>检查连接</button></aside>}
    {tabs}
    {!loading && treeStateReady && <SmartViewBar views={smartViews} activeId={smartViewId} disabled={batchMoving} onSelect={(id) => { setSmartViewId(id); setMode('browse'); }} />}
    {!loading && treeStateReady && !activeSmartView && <PinnedStrip links={pinnedLinks} settings={settings} onOpen={recordLinkClick} />}
    <section className="content" aria-busy={loading || !treeStateReady}>{loading || !treeStateReady ? <p className="state">正在连接本机书签库…</p> : activeSmartView ? <SmartViewPanel view={activeSmartView} folders={folders} settings={settings} readOnly={offlineSnapshot} onRecord={recordLinkClick} onRetry={(link) => void retryMetadata(link)} onEdit={(link) => setDialog({ type: 'link', link })} onMergeDuplicates={(items) => setDialog({ type:'merge-duplicates', links:items })} onOpenMaintenance={() => setDialog({ type:'maintenance' })} /> : !selectedFolder ? <Empty onAdd={() => setDialog({ type: 'folder' })} /> : <>
      <div className="section-heading"><div><FolderBreadcrumb path={selectedFolderPath} onSelect={selectFolder} /><h2>{selectedFolder.name}</h2><p>{links.length} 个{isInbox ? '待整理' : '链接'}{offlineSnapshot ? ' · 离线快照只读' : mode === 'organize' ? isInbox ? ' · 选择后批量移动，也可逐项编辑' : tagView === 'tree' ? ' · 可排序，也可拖到标签树归类' : ' · 可拖动标签或链接排序' : isInbox ? ' · 点击“整理收集箱”开始归类' : ''}</p></div><div className="section-heading-actions"><button className="text-button" disabled={batchMoving || !folderSubtreeIds(folders, selectedFolder.id).some((id) => (libraryLinks[id] ?? []).length)} onClick={() => setDialog({ type: 'batch-open', folder: selectedFolder })}>批量打开</button>{!offlineSnapshot && <button className="text-button" disabled={batchMoving} onClick={() => setDialog({ type: 'folder', folder: selectedFolder })}>管理此标签</button>}</div></div>
      {mode === 'organize' && !offlineSnapshot && isInbox && <BatchOrganizer selectedCount={selectedLinkIds.size} totalCount={links.length} targetFolderId={batchTargetId} folders={batchTargets} busy={batchMoving} onToggleAll={() => setSelectedLinkIds((current) => current.size === links.length ? new Set() : new Set(links.map((link) => link.id)))} onTargetChange={setBatchTargetId} onMove={() => void moveSelectedLinks()} onCreateFolder={() => setDialog({ type: 'folder' })} />}
      {mode === 'organize' && !offlineSnapshot ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderLinks(event)}><SortableContext items={links.map((link) => link.id)} strategy={rectSortingStrategy}><div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <SortableCard key={link.id} link={link} settings={settings} selectable={isInbox} selected={selectedLinkIds.has(link.id)} disabled={isInbox && batchMoving} treeMoveIds={tagView === 'tree' ? selectedLinkIds.has(link.id) && selectedLinkIds.size ? [...selectedLinkIds] : [link.id] : undefined} onToggle={() => toggleSelectedLink(link.id)} onOpen={() => openLink(link)} onEdit={() => setDialog({ type: 'link', link })} onPin={() => void togglePin(link)} />)}<AddCard folderName={selectedFolder.name} empty={links.length === 0} disabled={batchMoving} onClick={() => setDialog({ type: 'link' })} /></div></SortableContext></DndContext> : <><div className={`links ${settings.layout} columns-${settings.columnMode}`}>{links.map((link) => <BrowseCard key={link.id} link={link} settings={settings} onRecord={() => recordLinkClick(link)} onRetry={() => void retryMetadata(link)} />)}{!offlineSnapshot && <AddCard folderName={selectedFolder.name} empty={links.length === 0} onClick={() => setDialog({ type: 'link' })} />}</div>{!offlineSnapshot && settings.showRecommendations && <RecommendationStrip links={currentRecommendations} settings={settings} onOpen={recordLinkClick} />}</>}
    </>}</section>
    {toast && <Toast action={undoAction?.message === toast ? '撤销' : undefined} onAction={undoAction?.message === toast ? () => { void undoAction.run().catch((cause) => setError(`恢复失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`)); } : undefined}>{toast}</Toast>}
    {dialog?.type === 'link' && (dialog.link?.folderId ?? selectedFolderId) && <LinkDialog link={dialog.link} initial={dialog.initial} initialDeleteArmed={dialog.deleteArmed} folderId={(dialog.link?.folderId ?? selectedFolderId)!} folders={folders} onClose={() => setDialog(null)} onSaved={(next) => { updateLibraryLink(next, dialog.link?.folderId); setLinks((items) => { const exists = items.some((item) => item.id === next.id); if (next.folderId !== selectedFolderId) return exists ? items.filter((item) => item.id !== next.id) : items; return exists ? items.map((item) => item.id === next.id ? next : item) : [...items, next]; }); setDialog(null); setToast(dialog.link ? '链接已更新' : '链接已添加'); }} onDeleted={(id, name) => { setLinks((items) => items.filter((item) => item.id !== id)); setLibraryLinks((current) => Object.fromEntries(Object.entries(current).map(([folderId, items]) => [folderId, items.filter((item) => item.id !== id)]))); setDialog(null); const message = `已将链接“${name}”移入回收站`; setToast(message); setUndoAction({ message, run: async () => { await api.restoreLink(id); setUndoAction(null); setToast(`已恢复链接“${name}”`); await load(); await refreshTrashCount(); } }); void refreshTrashCount(); }} />}
    {dialog?.type === 'folder' && <FolderDialog folder={dialog.folder} parentId={dialog.parentId} linkCount={dialog.folder?.id === selectedFolderId ? links.length : dialog.folder?.linkCount ?? 0} onClose={() => setDialog(null)} onSaved={(next) => { setFolders((items) => dialog.folder ? items.map((item) => item.id === next.id ? next : item) : [...items, next]); refreshContextMenus(); setSelectedFolderId(next.id); setDialog(null); const moved = (next as Folder & { autoCollected?: number }).autoCollected ?? 0; setToast(dialog.folder ? moved ? `标签已更新，已自动归集 ${moved} 个链接` : '标签已更新' : '标签已添加'); if (!dialog.folder && dialog.parentId) void api.moveFolder(next.id, dialog.parentId, 0).finally(() => void load()); else void load(); }} onDeleted={(id, name) => { deleteFolder(id, name); refreshContextMenus(); }} />}
    {dialog?.type === 'batch-open' && <BatchOpenDialog folder={dialog.folder} folders={folders} linksByFolder={libraryLinks} onClose={() => setDialog(null)} onOpen={(items, destination) => void openLinkBatch(items, destination)} />}
    {dialog?.type === 'merge-duplicates' && <DuplicateMergeDialog links={dialog.links} folders={folders} onClose={() => setDialog(null)} onMerged={async (count) => { setDialog(null); setToast(`已合并 ${count} 个重复链接，其余记录已进入回收站`); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'maintenance' && <LinkMaintenanceDialog links={allLinks} folders={folders} onClose={() => setDialog(null)} onChanged={async () => { await load(); }} />}
    {dialog?.type === 'settings' && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onOpenConnection={() => setDialog({ type: 'connection' })} onSaved={(next) => { setSettings(next); setDialog(null); setToast('显示设置已保存'); }} />}
    {dialog?.type === 'trash' && <TrashDialog onClose={() => setDialog(null)} onRestored={async (message) => { setToast(message); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'versions' && <VersionsDialog onClose={() => setDialog(null)} onRestored={async (label) => { setDialog(null); setToast(`已恢复版本“${label}”`); await load(); await refreshTrashCount(); }} />}
    {dialog?.type === 'connection' && <ConnectionDialog onClose={() => setDialog(null)} />}
  </main>;
}

function AddCard({ folderName, empty, disabled = false, onClick }: { folderName: string; empty: boolean; disabled?: boolean; onClick(): void }) { return <button className="add-card" disabled={disabled} onClick={onClick} aria-label={`在${folderName}中添加链接`}><strong>添加链接</strong><small>{empty ? '从第一个网址开始' : `添加到“${folderName}”`}</small></button>; }
function Empty({ onAdd }: { onAdd(): void }) { return <div className="empty"><h2>从第一个标签开始</h2><ol className="starter-steps"><li>创建标签，例如“工作”或“常用”</li><li>添加第一个网址，可填写自己的标题和简介</li><li>以后打开新标签页，直接点击卡片访问</li></ol><button className="primary" onClick={onAdd}>创建第一个标签</button></div>; }

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown); }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button className="quiet-button" onClick={onClose}>关闭</button></header>{children}</section></div>;
}

function LinkMaintenanceDialog({ links, folders, onClose, onChanged }: { links: Link[]; folders: Folder[]; onClose(): void; onChanged(): Promise<void> }) {
  const [items, setItems] = useState(links); const [filter, setFilter] = useState<'issues' | 'all'>('issues'); const [checking, setChecking] = useState(false); const [progress, setProgress] = useState(0); const [busyId, setBusyId] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  const issueStatuses = new Set(['redirected','broken','unreachable']); const issues = items.filter((link) => issueStatuses.has(link.healthStatus)); const visible = filter === 'issues' ? issues : items;
  const statusLabel = (link: Link) => link.healthStatus === 'ok' ? '正常' : link.healthStatus === 'redirected' ? '永久重定向' : link.healthStatus === 'broken' ? '疑似失效' : link.healthStatus === 'unreachable' ? '暂不可达' : link.healthStatus === 'unsupported' ? '不支持检查' : '未检查';
  async function checkAll() { setChecking(true); setProgress(0); setMessage(null); try { const next = new Map(items.map((link) => [link.id, link])); for (let index=0; index<items.length; index+=30) { const chunk=items.slice(index,index+30); const result=await api.checkLinkHealth(chunk.map((link)=>link.id)); for(const link of result.checked) next.set(link.id,link); setItems([...next.values()]); setProgress(Math.min(items.length,index+chunk.length)); } await onChanged(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '检查过程中断'); } finally { setChecking(false); } }
  async function applyRedirect(link: Link) { setBusyId(link.id); setMessage(null); try { const updated=await api.applyLinkRedirect(link.id); setItems((current)=>current.map((item)=>item.id===updated.id?updated:item)); await onChanged(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '更新重定向失败'); } finally { setBusyId(null); } }
  return <DialogFrame title="链接维护中心" onClose={onClose}><div className="maintenance-dialog"><div className="maintenance-summary"><div><strong>{issues.length}</strong><span>个待处理问题</span></div><button type="button" className="primary" disabled={checking || !items.length} onClick={() => void checkAll()}>{checking ? `正在检查 ${progress}/${items.length}` : `检查全部 ${items.length} 个链接`}</button></div><div className="maintenance-filter" aria-label="显示范围"><button type="button" className={filter==='issues'?'active':''} onClick={()=>setFilter('issues')}>待处理 {issues.length}</button><button type="button" className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>全部 {items.length}</button></div>{message&&<p className="form-error">{message}</p>}<div className="maintenance-list">{visible.length ? visible.map((link)=><article key={link.id}><div className="maintenance-copy"><strong>{displayTitle(link)}</strong><span>{folders.find((folder)=>folder.id===link.folderId)?.name??'未知标签'} · {displayHost(link.url)}</span>{link.healthRedirectUrl&&<span title={link.healthRedirectUrl}>跳转到 {displayHost(link.healthRedirectUrl)}</span>}{link.healthError&&<span>{link.healthError}</span>}</div><div className="maintenance-actions"><span className={`health-status ${link.healthStatus}`}>{statusLabel(link)}</span>{link.healthStatus==='redirected'&&link.healthRedirectUrl&&<button type="button" className="quiet-button" disabled={busyId===link.id} onClick={()=>void applyRedirect(link)}>{busyId===link.id?'更新中…':'更新网址'}</button>}</div></article>) : <p className="maintenance-empty">{filter==='issues'?'没有待处理的链接问题。':'没有链接。'}</p>}</div></div></DialogFrame>;
}

function DuplicateMergeDialog({ links, folders, onClose, onMerged }: { links: Link[]; folders: Folder[]; onClose(): void; onMerged(count: number): Promise<void> }) {
  const groups = [...links.reduce((map, link) => { const group = map.get(link.url) ?? []; group.push(link); map.set(link.url, group); return map; }, new Map<string, Link[]>())].filter(([, items]) => items.length > 1);
  const [url, setUrl] = useState(groups[0]?.[0] ?? ''); const current = groups.find(([groupUrl]) => groupUrl === url)?.[1] ?? []; const [keepId, setKeepId] = useState(current[0]?.id ?? ''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (!current.some((link) => link.id === keepId)) setKeepId(current[0]?.id ?? ''); }, [url, current, keepId]);
  async function merge() { if (!keepId || current.length < 2) return; setBusy(true); setMessage(null); try { const result = await api.mergeLinks(keepId, current.filter((link) => link.id !== keepId).map((link) => link.id)); await onMerged(result.merged); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '合并失败'); } finally { setBusy(false); } }
  return <DialogFrame title="合并重复链接" onClose={onClose}><div className="merge-duplicates-dialog">{groups.length > 1 && <label className="merge-group-select">重复网址<select value={url} onChange={(event) => setUrl(event.target.value)}>{groups.map(([groupUrl, items]) => <option key={groupUrl} value={groupUrl}>{displayHost(groupUrl)} · {items.length} 条</option>)}</select></label>}<p className="merge-note">选择一条主记录。主记录保留原标签和位置，并补齐空白信息；其他记录的点击事件会转入主记录，随后进入回收站。</p><div className="merge-candidates">{current.map((link) => <label key={link.id} className={keepId === link.id ? 'selected' : ''}><input type="radio" name="merge-keep" checked={keepId === link.id} onChange={() => setKeepId(link.id)} /><span><strong>{displayTitle(link)}</strong><small>{folders.find((folder) => folder.id === link.folderId)?.name ?? '未知标签'} · {link.clickCount} 次访问</small><small>{link.description ? '有简介' : '无简介'} · {link.appearanceOverride ? '有自定义外观' : '默认外观'}</small></span><b>{keepId === link.id ? '保留' : '合并'}</b></label>)}</div>{message && <p className="form-error">{message}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={busy || !keepId || current.length < 2} onClick={() => void merge()}>{busy ? '合并中…' : `合并 ${Math.max(0, current.length - 1)} 条记录`}</button></footer></div></DialogFrame>;
}

function BatchOpenDialog({ folder, folders, linksByFolder, onClose, onOpen }: { folder: Folder; folders: Folder[]; linksByFolder: Record<string, Link[]>; onClose(): void; onOpen(items: Link[], destination: 'current' | 'window'): void }) {
  const [scope, setScope] = useState<'folder' | 'subtree'>('folder'); const [destination, setDestination] = useState<'current' | 'window'>('window');
  const direct = [...new Map((linksByFolder[folder.id] ?? []).map((link) => [link.url, link])).values()];
  const subtreeIds = folderSubtreeIds(folders, folder.id); const subtree = [...new Map(subtreeIds.flatMap((id) => linksByFolder[id] ?? []).map((link) => [link.url, link])).values()];
  const selected = scope === 'folder' ? direct : subtree; const hiddenCount = Math.max(0, selected.length - 5);
  return <DialogFrame title={`批量打开“${folder.name}”`} onClose={onClose}><div className="batch-open-dialog"><fieldset><legend>范围</legend><label className="batch-open-option"><input type="radio" name="batch-open-scope" checked={scope === 'folder'} onChange={() => setScope('folder')} /><span><strong>当前标签</strong><small>{direct.length} 个不同网址</small></span></label><label className="batch-open-option"><input type="radio" name="batch-open-scope" checked={scope === 'subtree'} onChange={() => setScope('subtree')} /><span><strong>整个子树</strong><small>{subtree.length} 个不同网址，包含 {Math.max(0, subtreeIds.length - 1)} 个子标签</small></span></label></fieldset><fieldset><legend>打开位置</legend><label className="batch-open-option"><input type="radio" name="batch-open-destination" checked={destination === 'window'} onChange={() => setDestination('window')} /><span><strong>新窗口</strong><small>保持当前页面不变</small></span></label><label className="batch-open-option"><input type="radio" name="batch-open-destination" checked={destination === 'current'} onChange={() => setDestination('current')} /><span><strong>当前窗口</strong><small>在后台创建新标签页</small></span></label></fieldset>{selected.length > 0 ? <div className="batch-open-preview"><strong>即将打开 {selected.length} 个链接</strong><ul>{selected.slice(0, 5).map((link) => <li key={link.id}>{displayTitle(link)}</li>)}</ul>{hiddenCount > 0 && <span>另有 {hiddenCount} 个链接</span>}</div> : <p className="batch-open-empty">这个范围内没有可打开的链接。</p>}{selected.length > 12 && <p className="batch-open-warning" role="alert">数量较多，可能占用较多内存。确认后会一次打开 {selected.length} 个标签页。</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!selected.length} onClick={() => onOpen(selected, destination)}>打开 {selected.length} 个链接</button></footer></div></DialogFrame>;
}

function TrashDialog({ onClose, onRestored }: { onClose(): void; onRestored(message: string): Promise<void> }) {
  const [trash, setTrash] = useState<TrashSnapshot | null>(null); const [busyId, setBusyId] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  async function loadTrash() { try { setTrash(await api.trash()); setMessage(null); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '无法读取回收站'); } }
  useEffect(() => { void loadTrash(); }, []);
  async function restoreFolder(id: string, name: string) { setBusyId(id); try { await api.restoreFolder(id); await loadTrash(); await onRestored(`已恢复标签“${name}”`); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '恢复标签失败'); } finally { setBusyId(null); } }
  async function restoreLink(id: string, title: string) { setBusyId(id); try { await api.restoreLink(id); await loadTrash(); await onRestored(`已恢复链接“${title}”`); } catch (cause) { setMessage(cause instanceof Error ? cause.message : '恢复链接失败'); } finally { setBusyId(null); } }
  const empty = trash && !trash.folders.length && !trash.links.length;
  return <DialogFrame title="回收站" onClose={onClose}><div className="trash-view" aria-busy={!trash}><p className="trash-note">删除的内容保留原位置，可随时恢复。当前不会自动清空。</p>{message && <p className="form-error">{message}</p>}{!trash ? <p className="trash-empty">正在读取回收站…</p> : empty ? <p className="trash-empty">回收站是空的。</p> : <>{trash.folders.length > 0 && <section><h3>标签</h3><div className="trash-list">{trash.folders.map((folder) => <article key={folder.id}><div><strong>{folder.name}</strong><span>{folder.descendantCount ? `${folder.descendantCount} 个子标签 · ` : ''}{folder.linkCount} 个链接 · {dateFormat.format(new Date(folder.deletedAt))}</span></div><button type="button" className="quiet-button" disabled={busyId === folder.id} onClick={() => void restoreFolder(folder.id, folder.name)}>{busyId === folder.id ? '恢复中…' : '恢复'}</button></article>)}</div></section>}{trash.links.length > 0 && <section><h3>链接</h3><div className="trash-list">{trash.links.map((link) => { const title = link.title || displayHost(link.url); return <article key={link.id}><div><strong>{title}</strong><span>{link.folderName} · {dateFormat.format(new Date(link.deletedAt))}</span></div><button type="button" className="quiet-button" disabled={busyId === link.id} onClick={() => void restoreLink(link.id, title)}>{busyId === link.id ? '恢复中…' : '恢复'}</button></article>; })}</div></section>}</>}</div></DialogFrame>;
}

function VersionsDialog({ onClose, onRestored }: { onClose(): void; onRestored(label: string): Promise<void> }) {
  const [versions,setVersions]=useState<LibrarySnapshotVersion[]|null>(null); const [label,setLabel]=useState('手动快照'); const [busy,setBusy]=useState<string|null>(null); const [message,setMessage]=useState<string|null>(null);
  async function loadVersions(){try{setVersions(await api.snapshots());setMessage(null);}catch(cause){setMessage(cause instanceof Error?cause.message:'无法读取版本快照');}}
  useEffect(()=>{void loadVersions();},[]);
  async function create(){if(!label.trim())return;setBusy('create');try{await api.createSnapshot(label.trim());await loadVersions();setMessage('快照已创建。');}catch(cause){setMessage(cause instanceof Error?cause.message:'创建快照失败');}finally{setBusy(null);}}
  async function restore(version:LibrarySnapshotVersion){if(!window.confirm(`恢复版本“${version.label}”？当前书签库会先自动创建保护快照，然后替换为该版本。`))return;setBusy(version.id);try{await api.restoreSnapshot(version.id);await onRestored(version.label);}catch(cause){setMessage(cause instanceof Error?cause.message:'恢复版本失败');}finally{setBusy(null);}}
  const kindLabel=(kind:LibrarySnapshotVersion['kind'])=>kind==='daily'?'每日自动':kind==='pre_restore'?'恢复前保护':'手动';
  return <DialogFrame title="版本快照" onClose={onClose}><div className="versions-dialog"><p className="versions-note">每天首次启动服务时自动保存一份，最多保留 30 份。恢复不会删除点击记录，并会先创建“恢复前自动快照”。</p><div className="version-create"><input value={label} maxLength={120} onChange={(event)=>setLabel(event.target.value)} aria-label="快照名称"/><button type="button" className="primary" disabled={busy==='create'||!label.trim()} onClick={()=>void create()}>{busy==='create'?'创建中…':'创建快照'}</button></div>{message&&<p className={message==='快照已创建。'?'connection-status connected':'form-error'}>{message}</p>}{!versions?<p className="versions-empty">正在读取版本…</p>:versions.length?<div className="version-list">{versions.map((version)=><article key={version.id}><div><strong>{version.label}</strong><span>{kindLabel(version.kind)} · {version.folderCount} 个标签 · {version.linkCount} 个链接</span><span>{dateFormat.format(new Date(version.createdAt))}</span></div><button type="button" className="quiet-button" disabled={busy===version.id} onClick={()=>void restore(version)}>{busy===version.id?'恢复中…':'恢复'}</button></article>)}</div>:<p className="versions-empty">还没有版本快照。</p>}</div></DialogFrame>;
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
function HistoryItem({ item, onOpen, onAdd, onDelete }: { item: BrowserHistoryPage; onOpen(url: string): void; onAdd(item: BrowserHistoryPage): void; onDelete(item: BrowserHistoryPage): void }) {
  const title = item.title || historyHostname(item.url); const initial = title.trim().slice(0, 1).toUpperCase() || '·';
  return <article className="history-item"><button type="button" className="history-open" onClick={() => onOpen(item.url)} aria-label={`打开 ${title}`}><span className="history-mark" aria-hidden="true">{initial}</span><span className="history-copy"><strong>{title}</strong><span className="history-domain">{historyHostname(item.url)}</span></span><span className="history-meta"><time dateTime={new Date(item.lastVisitTime).toISOString()}>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.lastVisitTime))}</time>{item.visitCount > 0 && <span>{item.visitCount} 次访问</span>}</span></button><button type="button" className="history-add quiet-button" onClick={() => onAdd(item)}>加入标签</button><button type="button" className="history-delete quiet-button" onClick={() => onDelete(item)} aria-label={`删除 ${title}`}>删除</button></article>;
}
function HistoryDomainBranch({ branch, depth, onOpen, onAdd, onDelete }: { branch: DomainBranch; depth: number; onOpen(url: string): void; onAdd(item: BrowserHistoryPage): void; onDelete(item: BrowserHistoryPage): void }) {
  const directItems = branch.items.filter((item) => historyFullHostname(item.url) === branch.hostname);
  return <section className="history-domain-branch" style={{ '--domain-depth': String(depth) } as React.CSSProperties}><h4>{branch.hostname}<span>{branch.items.length} 条</span></h4>{directItems.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} onDelete={onDelete} />)}{[...branch.children.values()].map((child) => <HistoryDomainBranch key={child.hostname} branch={child} depth={depth + 1} onOpen={onOpen} onAdd={onAdd} onDelete={onDelete} />)}</section>;
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
  async function deleteHistory(item: BrowserHistoryPage) {
    const title = item.title || historyHostname(item.url);
    if (!window.confirm(`删除本机记录“${title}”？这不会删除 Chrome 中的原始历史。`)) return;
    setMessage(null);
    try {
      await api.deleteHistory(item.url);
      setEntries((current) => current.filter((entry) => entry.url !== item.url));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '删除记录失败'); }
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
  return <div className="history-panel"><div className="section-heading"><div><h2>浏览记录</h2><p>保存在本机 · 最近访问优先 · 删除不会影响 Chrome 原始历史</p></div>{!loading && entries.length > 0 && <span className="history-count">已显示 {entries.length} 条</span>}</div><div className="history-controls"><label>搜索记录<input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或网址" /></label><div className="history-group-switch" aria-label="分组方式"><button type="button" className={groupBy === 'date' ? 'active' : ''} onClick={() => setGroupBy('date')}>按日期</button><button type="button" className={groupBy === 'domain' ? 'active' : ''} onClick={() => setGroupBy('domain')}>按域名</button></div></div>{message && <p className="form-error">{message}</p>}<div className={`history-list ${groupBy === 'domain' ? 'grouped-by-domain' : ''}`} aria-busy={loading}>{loading ? <p className="history-state">正在读取本机浏览记录…</p> : entries.length === 0 ? <p className="history-state">{emptyMessage}</p> : groupBy === 'date' ? groups.map((group) => <section className="history-day" key={group.label}><h3>{group.label}<span>{group.items.length} 条</span></h3>{group.items.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} onDelete={deleteHistory} />)}</section>) : byDomain.map((group) => <section className="history-domain-group" key={group.domain}><h3>{group.domain}<span>{group.items.length + [...group.children.values()].reduce((total, child) => total + child.items.length, 0)} 条</span></h3>{group.items.map((item) => <HistoryItem key={item.url} item={item} onOpen={onOpen} onAdd={onAdd} onDelete={deleteHistory} />)}{[...group.children.values()].map((branch) => <HistoryDomainBranch key={branch.hostname} branch={branch} depth={1} onOpen={onOpen} onAdd={onAdd} onDelete={deleteHistory} />)}</section>)}</div>{nextCursor && <div ref={loadMoreSentinel} className="history-load-sentinel" aria-live="polite">{loadingMore ? '正在加载更多记录…' : ''}</div>}</div>;
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
  return <DialogFrame title={link ? '编辑链接' : '添加链接'} onClose={onClose}><form onSubmit={save} className="form"><label>网址<input autoFocus required type="text" inputMode="url" value={draft.url} onChange={(event) => update('url', event.target.value)} onBlur={(event) => update('url', normalizeLinkUrl(event.target.value))} placeholder="example.com、https://example.com 或 chrome://..." /></label>{duplicates.length > 0 && <p className="duplicate-note">已存在 {duplicates.length} 个相同网址：{duplicates.map((item) => displayTitle(item)).join('、')}。仍可继续添加。</p>}<div className="quick-link-fields"><label>名称（可选）<input value={draft.displayName ?? ''} onChange={(event) => update('displayName', event.target.value)} placeholder="留空则使用网页标题" /></label><label>保存到标签<select value={targetFolderId} onChange={(event) => setTargetFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label></div><button type="button" className="advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((current) => !current)}>{showAdvanced ? '收起更多选项' : '更多选项'}</button>{showAdvanced && <div className="advanced-fields"><fieldset><legend>内容</legend><label>网页标题（可选）<input value={draft.title ?? ''} onChange={(event) => update('title', event.target.value)} /></label><label>简介（可选）<textarea value={draft.description ?? ''} onChange={(event) => update('description', event.target.value)} /></label></fieldset><fieldset><legend>卡片外观</legend><label>强调色<input type="color" value={draft.appearanceOverride?.accentColor ?? '#4f46e5'} onChange={(event) => updateAppearance('accentColor', event.target.value)} /></label><label>卡片底色<input type="color" value={draft.appearanceOverride?.cardColor ?? '#ffffff'} onChange={(event) => updateAppearance('cardColor', event.target.value)} /></label><label>自定义图标（可选）<input value={draft.appearanceOverride?.icon ?? ''} maxLength={8} onChange={(event) => updateAppearance('icon', event.target.value)} placeholder="例如 📚" /></label><button type="button" className="text-button reset-appearance" onClick={() => update('appearanceOverride', null)}>恢复默认外观</button></fieldset><fieldset><legend>自动信息</legend><label>图标网址（可选）<input type="url" value={draft.faviconUrl ?? ''} onChange={(event) => update('faviconUrl', event.target.value)} /></label><p className={`metadata-note ${link?.metadataStatus ?? 'pending'}`}>{automaticInfo}</p></fieldset></div>}<p className="hint">保存后会自动补齐空白的标题、简介和图标。</p>{deleteArmed && link && <DeleteConfirmation subject={`链接“${displayTitle(link)}”`} detail="删除后会进入回收站，可恢复原标签。" busy={busy} onCancel={() => setDeleteArmed(false)} onConfirm={() => void remove()} />}{message && <p className="form-error">{message}</p>}<footer>{link && !deleteArmed && <><button type="button" className="text-button" onClick={async () => { setBusy(true); try { onSaved(await api.refreshMetadata(link.id)); } catch (cause) { setMessage((cause as Error).message); } finally { setBusy(false); } }}>重新抓取</button><button type="button" className="danger" onClick={() => setDeleteArmed(true)}>删除链接</button></>}{!deleteArmed && <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>}</footer></form></DialogFrame>;
}

function DeleteConfirmation({ subject, detail, busy, onCancel, onConfirm }: { subject: string; detail: string; busy: boolean; onCancel(): void; onConfirm(): void }) { const safeDetail = detail.replace('也会永久删除', '和子标签会一并进入回收站，可恢复原层级'); return <div className="delete-confirm" role="alert"><strong>确认删除{subject}？</strong><span>{safeDetail}</span><div><button type="button" className="quiet-button" onClick={onCancel}>取消</button><button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy ? '删除中…' : '移入回收站'}</button></div></div>; }

function FolderDialog({ folder, parentId = null, linkCount, onClose, onSaved, onDeleted }: { folder?: Folder; parentId?: string | null; linkCount: number; onClose(): void; onSaved(folder: Folder): void; onDeleted(id: string, name: string): void }) {
  const [name, setName] = useState(folder?.name ?? ''); const [autoRulesText, setAutoRulesText] = useState(folder?.autoRules.join('\n') ?? ''); const [message, setMessage] = useState<string | null>(null); const [deleteArmed, setDeleteArmed] = useState(false); const [deleting, setDeleting] = useState(false);
  const isInbox = folder?.systemRole === 'inbox';
  const autoRules = () => [...new Set(autoRulesText.split(/[\n,]+/).map((rule) => rule.trim().toLowerCase()).filter(Boolean))];
  async function remove() { if (!folder) return; setDeleting(true); setMessage(null); try { await api.deleteFolder(folder.id); onDeleted(folder.id, folder.name); } catch (cause) { setMessage(`删除失败：${cause instanceof Error ? cause.message : '无法连接本机服务'}`); setDeleteArmed(false); } finally { setDeleting(false); } }
  return <DialogFrame title={isInbox ? '管理收集箱' : folder ? '管理标签' : '添加标签'} onClose={onClose}><form className="form" onSubmit={async (event) => { event.preventDefault(); setMessage(null); try { const input = { name, autoRules: isInbox ? [] : autoRules() }; onSaved(folder ? await api.updateFolder(folder.id, input) : await api.createFolder(input)); } catch (cause) { setMessage((cause as Error).message); } }}><label>标签名称<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>{isInbox ? <p className="system-folder-note"><strong>这是当前页面一键收藏的固定入口。</strong><span>可以改名，但不能删除或设置自动归集规则；将链接移出收集箱即代表整理完成。</span></p> : <fieldset><legend>自动归集规则</legend><label>匹配域名<textarea value={autoRulesText} onChange={(event) => setAutoRulesText(event.target.value)} placeholder={'例如：\n*.github.com\ngithub.com'} /></label><p className="hint">每行或逗号分隔一条。`*.github.com` 会匹配 github.com 及其子域名；保存后会立即归集已有链接。</p></fieldset>}{folder && <p className="hint">此标签包含 {linkCount} 个链接。{!isInbox && '多个标签命中同一网址时，以标签从左到右的顺序为准。'}</p>}{deleteArmed && folder && !isInbox && <DeleteConfirmation subject={`标签“${folder.name}”`} detail={`其中 ${linkCount} 个链接也会永久删除。`} busy={deleting} onCancel={() => setDeleteArmed(false)} onConfirm={() => void remove()} />}{message && <p className="form-error">{message}</p>}<footer>{folder && !isInbox && !deleteArmed && <button type="button" className="danger" onClick={() => setDeleteArmed(true)}>删除标签</button>}{!deleteArmed && <button className="primary">保存</button>}</footer></form></DialogFrame>;
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
