async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isPdd(url) {
  return /yangkeduo\.com|pinduoduo\.com/i.test(url || "");
}

const PDD_HOME_URL = "https://mobile.yangkeduo.com/";

async function init() {
  const stateEl = document.getElementById("page-state");
  const scanBtn = document.getElementById("scan");
  const openPddHomeBtn = document.getElementById("open-pdd-home");
  const openPanelBtn = document.getElementById("open-panel");
  const openExtBtn = document.getElementById("open-ext");
  const tab = await currentTab();

  openPddHomeBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: PDD_HOME_URL, active: true });
  });

  openExtBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions" });
  });

  if (!tab?.url || !isPdd(tab.url)) {
    stateEl.textContent = "当前标签不是拼多多。请先打开商品详情页。";
    scanBtn.disabled = true;
    openPanelBtn.disabled = true;
    return;
  }

  openPanelBtn.addEventListener("click", async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "pdd-dl-open-panel" });
      stateEl.textContent = "已打开页面面板，请看网页右下角。";
    } catch {
      stateEl.textContent = "找不到页面面板：请确认已安装插件并刷新商品页。";
    }
  });

  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: "pdd-dl-get-state" });
    if (!state?.isGoodsPage) {
      stateEl.textContent = "已是拼多多，但还不是商品详情页（需 goods_id）。";
      return;
    }
    if (state.needLogin) {
      stateEl.textContent = "当前页可能未登录，素材不完整。请登录拼多多并刷新页面后再扫描。";
      return;
    }
    const counts = state.counts || {};
    stateEl.textContent = `${state.title || "商品"} · 主图 ${counts.main || 0} / SKU ${counts.sku || 0} / 详情图 ${counts.detailImage || 0} / 详情视频 ${counts.detailVideo || 0} / 卖家秀 ${counts.sellerShow || 0}`;
  } catch {
    stateEl.textContent = "插件未连上此页：请加载扩展后刷新商品页（F5）。";
  }

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "pdd-dl-scan" });
      stateEl.textContent = "已重新扫描，请看右下角面板里的数量。";
    } catch {
      stateEl.textContent = "扫描失败：请在扩展管理页加载「多多商品素材下载器」文件夹并刷新商品页。";
    } finally {
      scanBtn.disabled = false;
    }
  });
}

init();
