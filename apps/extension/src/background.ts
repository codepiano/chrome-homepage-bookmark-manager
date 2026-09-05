import { getConnection } from './api';

type CaptureRecord = { url: string; title: string | null; folderId?: string };
type CaptureResponse = { status: 'created' | 'already-saved'; folder: { id: string; name: string } };
type Folder = { id: string; name: string; systemRole: 'inbox' | null };

const CAPTURE_OUTBOX_KEY = 'captureOutbox';
const ALARM = 'capture-retry';
const CONTEXT_MENU_ROOT = 'local-speed-dial-capture';
const CONTEXT_MENU_INBOX = 'local-speed-dial-capture:inbox';
const CONTEXT_MENU_FOLDER_PREFIX = 'local-speed-dial-capture:folder:';
let syncing = false;
let contextFolderNames = new Map<string, string>();
let contextMenusRefresh: Promise<void> | null = null;

async function post<T = void>(path: string, body: unknown): Promise<T> {
  const { apiBaseUrl, token } = await getConnection();
  if (!token) throw new Error('Local service is not paired');
  const response = await fetch(`${apiBaseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local service returned ${response.status}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const { apiBaseUrl, token } = await getConnection();
  if (!token) throw new Error('Local service is not paired');
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Local service returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function readCaptureOutbox() {
  const value = await chrome.storage.local.get(CAPTURE_OUTBOX_KEY);
  return (value[CAPTURE_OUTBOX_KEY] as CaptureRecord[] | undefined) ?? [];
}
async function enqueueCapture(record: CaptureRecord) {
  const outbox = await readCaptureOutbox();
  await chrome.storage.local.set({ [CAPTURE_OUTBOX_KEY]: [...outbox.filter((item) => item.url !== record.url), record] });
}
async function flushCaptureOutbox() {
  let outbox = await readCaptureOutbox();
  while (outbox.length) {
    try { await post('/api/capture', outbox[0]); }
    catch { return false; }
    outbox = outbox.slice(1);
    await chrome.storage.local.set({ [CAPTURE_OUTBOX_KEY]: outbox });
  }
  return true;
}

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    await flushCaptureOutbox();
  } finally { syncing = false; }
}

function schedule() { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); void sync(); }
async function showCaptureFeedback(tabId: number | undefined, text: string, title: string, color: string) {
  if (tabId === undefined) return;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]);
  setTimeout(() => { void chrome.action.setBadgeText({ tabId, text: '' }); void chrome.action.setTitle({ tabId, title: '收藏当前页面到收集箱' }); }, 2800);
}
function isCapturableUrl(url: string | undefined): url is string {
  return Boolean(url && /^(https?:|chrome:)/i.test(url) && !url.startsWith('chrome-extension://'));
}
async function capture(record: CaptureRecord, tabId: number | undefined, fallbackFolderName = '收集箱') {
  if (!isCapturableUrl(record.url)) { await showCaptureFeedback(tabId, '!', '这个页面不能收藏', '#b42318'); return; }
  await chrome.action.setBadgeText({ tabId, text: '' });
  try {
    const result = await post<CaptureResponse>('/api/capture', record);
    await showCaptureFeedback(tabId, result.status === 'created' ? '✓' : '=', result.status === 'created' ? `已收藏到“${result.folder.name}”` : '这个页面已经收藏', result.status === 'created' ? '#198754' : '#596579');
  } catch {
    await enqueueCapture(record);
    await showCaptureFeedback(tabId, '…', `本机服务离线，已暂存，恢复后会收藏到“${fallbackFolderName}”`, '#9a6700');
  }
}
function removeAllContextMenus() { return new Promise<void>((resolve) => { chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; resolve(); }); }); }
function refreshContextMenus() {
  if (contextMenusRefresh) return contextMenusRefresh;
  contextMenusRefresh = refreshContextMenusInternal().catch(() => undefined).finally(() => { contextMenusRefresh = null; });
  return contextMenusRefresh;
}
async function refreshContextMenusInternal() {
  let folders: Folder[] = [];
  try { folders = await get<Folder[]>('/api/folders'); } catch { /* Keep the reliable inbox fallback while disconnected. */ }
  contextFolderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  await removeAllContextMenus();
  chrome.contextMenus.create({ id: CONTEXT_MENU_ROOT, title: '收藏到 Local Speed Dial', contexts: ['page', 'link'] });
  const inbox = folders.find((folder) => folder.systemRole === 'inbox');
  chrome.contextMenus.create({ id: CONTEXT_MENU_INBOX, parentId: CONTEXT_MENU_ROOT, title: inbox ? `${inbox.name}（稍后整理）` : '收集箱（稍后整理）', contexts: ['page', 'link'] });
  for (const folder of folders.filter((folder) => folder.systemRole !== 'inbox')) chrome.contextMenus.create({ id: `${CONTEXT_MENU_FOLDER_PREFIX}${folder.id}`, parentId: CONTEXT_MENU_ROOT, title: folder.name, contexts: ['page', 'link'] });
}
chrome.action.onClicked.addListener((tab) => { void capture({ url: tab.url?.trim() ?? '', title: tab.title?.trim() || null }, tab.id); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (typeof info.menuItemId !== 'string' || (info.menuItemId !== CONTEXT_MENU_INBOX && !info.menuItemId.startsWith(CONTEXT_MENU_FOLDER_PREFIX))) return;
  const folderId = info.menuItemId.startsWith(CONTEXT_MENU_FOLDER_PREFIX) ? info.menuItemId.slice(CONTEXT_MENU_FOLDER_PREFIX.length) : undefined;
  const fallbackFolderName = folderId ? contextFolderNames.get(folderId) ?? '所选标签' : '收集箱';
  void capture({ url: (info.linkUrl ?? info.pageUrl)?.trim() ?? '', title: tab?.title?.trim() || null, ...(folderId ? { folderId } : {}) }, tab?.id, fallbackFolderName);
});
chrome.runtime.onInstalled.addListener(() => { schedule(); void refreshContextMenus(); });
chrome.runtime.onStartup.addListener(() => { schedule(); void refreshContextMenus(); });
chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'refresh-context-menus') void refreshContextMenus(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void sync(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.apiBaseUrl && !changes.token)) return;
  void sync();
  void refreshContextMenus();
});

// Reloading an unpacked extension does not reliably emit onInstalled/onStartup.
// Always schedule one capture retry when the worker starts.
void refreshContextMenus();
schedule();
