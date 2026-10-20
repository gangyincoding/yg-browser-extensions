const inflight = new Map();
let downloadCancelled = false;
const activeDownloadIds = new Set();
/** 每个文件之间的间隔，减轻 Chrome 下载队列与 CDN 限流 */
const DOWNLOAD_DELAY_MS = 500;
const HISTORY_KEY = "pddDownloadHistory";

async function markDownloaded(goodsId, item, filename) {
  if (!goodsId || !item?.id) return;
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const store = data[HISTORY_KEY] || {};
  if (!store[goodsId]) store[goodsId] = {};
  store[goodsId][item.id] = {
    at: Date.now(),
    filename: filename || "",
    url: item.url || ""
  };
  await chrome.storage.local.set({ [HISTORY_KEY]: store });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportProgress(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "pdd-dl-progress", ...payload }).catch(() => {});
}

function safeSegment(value, fallback) {
  const text = String(value || fallback || "pdd")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 40) || fallback || "pdd";
}

function folderByCategory(category) {
  switch (category) {
    case "main":
      return "01-商品主图";
    case "sku":
      return "02-SKU图";
    case "detailImage":
      return "03-详情页图片";
    case "detailVideo":
      return "04-详情页视频";
    case "sellerShow":
      return "05-卖家秀视频";
    default:
      return "99-其他";
  }
}

function pad(index) {
  return String(index + 1).padStart(2, "0");
}

function buildFilename(item, index, goodsId, title) {
  const root = `多多商品素材/${safeSegment(goodsId, "goods")}_${safeSegment(title, "商品")}`;
  const folder = folderByCategory(item.category);
  const label = item.label ? `_${safeSegment(item.label, "")}` : "";
  const ext = (item.ext || (item.kind === "video" ? "mp4" : "jpg")).replace(/^\./, "");
  return `${root}/${folder}/${pad(index)}${label}.${ext}`;
}

function waitDownload(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!inflight.has(id)) return;
      inflight.delete(id);
      resolve({ id, ok: false, error: "timeout" });
    }, 120000);
    inflight.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function cancelAllDownloads() {
  downloadCancelled = true;
  const ids = [...activeDownloadIds];
  await Promise.all(
    ids.map((id) =>
      chrome.downloads.cancel(id).catch(() => {})
    )
  );
  activeDownloadIds.clear();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!inflight.has(delta.id)) return;
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
    activeDownloadIds.delete(delta.id);
    const resolve = inflight.get(delta.id);
    inflight.delete(delta.id);
    resolve({
      id: delta.id,
      ok: delta.state.current === "complete",
      error: delta.error?.current || ""
    });
  }
});

async function downloadOne(item, filename) {
  if (downloadCancelled) return { ok: false, error: "cancelled" };
  try {
    const id = await chrome.downloads.download({
      url: item.url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    activeDownloadIds.add(id);
    const result = await waitDownload(id);
    activeDownloadIds.delete(id);
    return result;
  } catch (error) {
    if (downloadCancelled) return { ok: false, error: "cancelled" };
    try {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (downloadCancelled) return { ok: false, error: "cancelled" };
      const objectUrl = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      activeDownloadIds.add(id);
      const result = await waitDownload(id);
      activeDownloadIds.delete(id);
      URL.revokeObjectURL(objectUrl);
      return result;
    } catch (fallbackError) {
      return { ok: false, error: fallbackError.message || String(error) };
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "pdd-dl-cancel") {
    cancelAllDownloads().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type !== "pdd-dl-download") return;

  const { items = [], goodsId = "", title = "" } = message;
  const tabId = sender.tab?.id;
  (async () => {
    downloadCancelled = false;
    let done = 0;
    let failed = 0;
    let cancelled = 0;
    const counters = {};
    const total = items.length;

    reportProgress(tabId, { index: 0, total, done, failed, phase: "start" });

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (downloadCancelled) {
        cancelled += items.length - i;
        break;
      }

      reportProgress(tabId, { index: i + 1, total, done, failed, phase: "downloading" });

      counters[item.category] = counters[item.category] || 0;
      const categoryIndex = counters[item.category];
      counters[item.category] += 1;
      const filename = buildFilename(item, categoryIndex, goodsId, title);
      const result = await downloadOne(item, filename);
      if (result.error === "cancelled") cancelled += 1;
      else if (result.ok) {
        done += 1;
        await markDownloaded(goodsId, item, filename);
      } else failed += 1;

      reportProgress(tabId, { index: i + 1, total, done, failed, phase: "item-done" });

      if (i < items.length - 1 && !downloadCancelled) {
        await sleep(DOWNLOAD_DELAY_MS);
      }
    }

    const wasCancelled = downloadCancelled;
    downloadCancelled = false;
    reportProgress(tabId, { index: total, total, done, failed, phase: "complete", stopped: wasCancelled });
    sendResponse({
      ok: failed === 0 && cancelled === 0,
      done,
      failed,
      cancelled,
      total: items.length,
      stopped: wasCancelled
    });
  })();

  return true;
});
