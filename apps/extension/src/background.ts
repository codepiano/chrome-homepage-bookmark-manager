import { getConnection } from './api';

type HistoryRecord = { url: string; title: string | null; lastVisitTime: number; visitCount: number; source: 'initial' | 'live' };
type BackfillState = { endTime?: number; complete?: boolean };
type HistoryRemoval = { allHistory: boolean; urls?: string[] };
type CaptureRecord = { url: string; title: string | null };
type CaptureResponse = { status: 'created' | 'already-saved' };

const OUTBOX_KEY = 'historySyncOutbox';
const REMOVAL_OUTBOX_KEY = 'historyRemovalSyncOutbox';
const BACKFILL_KEY = 'historyBackfillState';
const CAPTURE_OUTBOX_KEY = 'captureOutbox';
const ALARM = 'history-sync';
const BATCH_SIZE = 100;
let syncing = false;

function toRecord(item: chrome.history.HistoryItem, source: HistoryRecord['source']): HistoryRecord | null {
  if (!item.url || !item.lastVisitTime) return null;
  return { url: item.url.slice(0, 4096), title: item.title?.slice(0, 10_000) || null, lastVisitTime: Math.floor(item.lastVisitTime), visitCount: Math.max(0, item.visitCount ?? 0), source };
}

async function post<T = void>(path: string, body: unknown): Promise<T> {
  const { apiBaseUrl, token } = await getConnection();
  if (!token) throw new Error('Local service is not paired');
  const response = await fetch(`${apiBaseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local service returned ${response.status}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
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

async function readOutbox() {
  const value = await chrome.storage.local.get(OUTBOX_KEY);
  return (value[OUTBOX_KEY] as HistoryRecord[] | undefined) ?? [];
}
async function enqueue(records: HistoryRecord[]) {
  if (!records.length) return;
  const outbox = await readOutbox();
  const byKey = new Map(outbox.map((record) => [`${record.url}\u0000${record.lastVisitTime}`, record]));
  for (const record of records) byKey.set(`${record.url}\u0000${record.lastVisitTime}`, record);
  await chrome.storage.local.set({ [OUTBOX_KEY]: [...byKey.values()] });
}
async function flushOutbox() {
  const outbox = await readOutbox();
  if (!outbox.length) return true;
  try {
    await post('/api/history/records', { records: outbox.slice(0, BATCH_SIZE) });
    await chrome.storage.local.set({ [OUTBOX_KEY]: outbox.slice(BATCH_SIZE) });
    return outbox.length <= BATCH_SIZE;
  } catch { return false; }
}
async function enqueueRemoval(removed: HistoryRemoval) {
  const value = await chrome.storage.local.get(REMOVAL_OUTBOX_KEY);
  const outbox = (value[REMOVAL_OUTBOX_KEY] as HistoryRemoval[] | undefined) ?? [];
  const additions = removed.allHistory ? [{ allHistory: true }] : Array.from({ length: Math.ceil((removed.urls?.length ?? 0) / 500) }, (_, index) => ({ allHistory: false, urls: removed.urls!.slice(index * 500, (index + 1) * 500) }));
  await chrome.storage.local.set({ [REMOVAL_OUTBOX_KEY]: [...outbox, ...additions] });
}
async function flushRemovalOutbox() {
  const value = await chrome.storage.local.get(REMOVAL_OUTBOX_KEY);
  const outbox = (value[REMOVAL_OUTBOX_KEY] as HistoryRemoval[] | undefined) ?? [];
  if (!outbox.length) return true;
  try {
    await post('/api/history/removals', outbox[0]);
    await chrome.storage.local.set({ [REMOVAL_OUTBOX_KEY]: outbox.slice(1) });
    return outbox.length === 1;
  } catch { return false; }
}

async function syncBackfillPage() {
  const value = await chrome.storage.local.get(BACKFILL_KEY);
  const state = (value[BACKFILL_KEY] as BackfillState | undefined) ?? {};
  if (state.complete) return true;
  const items = await chrome.history.search({ text: '', startTime: 0, endTime: state.endTime ?? Date.now(), maxResults: BATCH_SIZE });
  const records = items.map((item) => toRecord(item, 'initial')).filter((item): item is HistoryRecord => item !== null);
  if (!records.length) { await chrome.storage.local.set({ [BACKFILL_KEY]: { ...state, complete: true } satisfies BackfillState }); return true; }
  try { await post('/api/history/records', { records }); } catch { return false; }
  const oldest = Math.min(...records.map((record) => record.lastVisitTime));
  await chrome.storage.local.set({ [BACKFILL_KEY]: { endTime: oldest - 1 } satisfies BackfillState });
  return false;
}

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    if (!await flushCaptureOutbox()) return;
    if (!await flushRemovalOutbox()) return;
    if (!await flushOutbox()) return;
    for (let page = 0; page < 5; page += 1) if (await syncBackfillPage()) break;
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
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const url = tab.url?.trim();
    if (!url || !/^(https?:|chrome:)/i.test(url) || url.startsWith('chrome-extension://')) {
      await showCaptureFeedback(tab.id, '!', '这个页面不能收藏', '#b42318');
      return;
    }
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    const record = { url, title: tab.title?.trim() || null };
    try {
      const result = await post<CaptureResponse>('/api/capture', record);
      await showCaptureFeedback(tab.id, result.status === 'created' ? '✓' : '=', result.status === 'created' ? '已收藏到收集箱' : '这个页面已经收藏', result.status === 'created' ? '#198754' : '#596579');
    } catch {
      await enqueueCapture(record);
      await showCaptureFeedback(tab.id, '…', '本机服务离线，已暂存并等待自动保存', '#9a6700');
    }
  })();
});
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void sync(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.apiBaseUrl && !changes.token)) return;
  void chrome.storage.local.set({ [BACKFILL_KEY]: {} satisfies BackfillState });
  void sync();
});
chrome.history.onVisited.addListener((item) => { const record = toRecord(item, 'live'); if (record) void enqueue([record]).then(sync); });
chrome.history.onVisitRemoved.addListener((removed) => { void enqueueRemoval(removed).then(sync); });
