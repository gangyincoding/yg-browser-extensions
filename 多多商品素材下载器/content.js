(() => {
  const SOURCE = "pdd-dl";
  const PREVIEW_LIMIT = 8;
  const COMPACT_THRESHOLD = 24;
  const DEFAULT_SELLER_BATCH = 20;
  const MAX_SELLER_BATCH = 100;
  const HISTORY_KEY = "pddDownloadHistory";
  const PDD_HOME_URL = "https://mobile.yangkeduo.com/";

  const CATEGORIES = [
    { id: "main", title: "商品主图", hint: "轮播原图" },
    { id: "sku", title: "SKU图", hint: "规格 / 颜色图" },
    { id: "detailImage", title: "详情页图片", hint: "详情长图" },
    { id: "detailVideo", title: "详情页视频", hint: "商品官方视频" },
    { id: "sellerShow", title: "卖家秀视频", hint: "评价区带视频晒单" }
  ];

  let panelShadow = null;
  let state = {
    title: "",
    goodsId: "",
    isGoodsPage: false,
    needLogin: false,
    hasGoodsData: false,
    scanReason: "",
    groups: emptyGroups(),
    selected: new Set(),
    openGroups: new Set(["main", "detailVideo", "sellerShow"]),
    sellerShowBatchSize: DEFAULT_SELLER_BATCH,
    sellerShowDownloadLimit: 0,
    sellerShowLimitEnabled: false,
    skipDownloaded: true,
    downloadHistory: {},
    historyGoodsId: "",
    downloading: false,
    downloadProgress: null,
    status: ""
  };

  function emptyGroups() {
    return {
      main: [],
      sku: [],
      detailImage: [],
      detailVideo: [],
      sellerShow: []
    };
  }

  function $(id) {
    return panelShadow ? panelShadow.getElementById(id) : null;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, "&#39;");
  }

  function requestScan() {
    window.postMessage({ source: SOURCE, direction: "ext-to-page", type: "scan" }, "*");
  }

  function openPddHome() {
    chrome.tabs.create({ url: PDD_HOME_URL, active: true });
  }

  function normalizeGoodsId(value) {
    return String(value || "").trim();
  }

  function allItems() {
    return CATEGORIES.flatMap((category) => state.groups[category.id] || []);
  }

  function applyDefaultSelection() {
    const next = new Set();
    for (const category of CATEGORIES) {
      const items = state.groups[category.id] || [];
      items.forEach((item, index) => {
        if (category.id === "sellerShow") {
          const batchSize = clampBatchSize(state.sellerShowBatchSize);
          if (items.length <= batchSize || index < batchSize) next.add(item.id);
        } else {
          next.add(item.id);
        }
      });
    }
    state.selected = next;
  }

  function mergeSelectionAfterRescan(previousSelected, oldIds) {
    const next = new Set();
    for (const category of CATEGORIES) {
      const items = state.groups[category.id] || [];
      items.forEach((item, index) => {
        const isNew = !oldIds.has(item.id);
        if (isNew) {
          if (category.id === "sellerShow") {
            const batchSize = clampBatchSize(state.sellerShowBatchSize);
            if (items.length <= batchSize || index < batchSize) next.add(item.id);
          } else {
            next.add(item.id);
          }
        } else if (previousSelected.has(item.id)) {
          next.add(item.id);
        }
      });
    }
    state.selected = next;
  }

  function resetPanelForNewGoods() {
    state.sellerShowDownloadLimit = 0;
    state.sellerShowLimitEnabled = false;
    state.downloadProgress = null;
    applyDefaultSelection();
  }

  async function syncGoodsContext(incomingGoodsId, goodsChanged) {
    if (goodsChanged) {
      resetPanelForNewGoods();
      if (incomingGoodsId) await loadDownloadHistory(incomingGoodsId);
      else {
        state.downloadHistory = {};
        state.historyGoodsId = "";
      }
      return;
    }
    if (incomingGoodsId && incomingGoodsId !== state.historyGoodsId) {
      await loadDownloadHistory(incomingGoodsId);
    }
  }

  function updateScanStatus() {
    if (state.downloading) return;
    const total = allItems().length;
    if (state.needLogin && total === 0) {
      state.status = "需要登录后重新扫描";
    } else if (total) {
      state.status = `已识别 ${total} 个资源`;
    } else if (state.isGoodsPage) {
      state.status = state.hasGoodsData ? "正在读取资源…" : "商品数据加载中…";
    } else {
      state.status = "";
    }
  }

  function selectedItems() {
    return allItems().filter((item) => state.selected.has(item.id));
  }

  function clampBatchSize(value) {
    const n = parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_SELLER_BATCH;
    return Math.min(MAX_SELLER_BATCH, n);
  }

  function clampDownloadLimit(value, max) {
    const n = parseInt(String(value), 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(max, n);
  }

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function parsePositiveInt(value, min, max) {
    const n = parseInt(digitsOnly(value), 10);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function activeSellerDownloadLimit() {
    if (!state.sellerShowLimitEnabled) return 0;
    return state.sellerShowDownloadLimit;
  }

  function isEditingSellerNumericInput() {
    const el = panelShadow?.activeElement;
    if (!el || typeof el.matches !== "function") return false;
    return el.matches("[data-seller-batch-size], [data-seller-download-limit]");
  }

  function chunkItems(items, size) {
    const batches = [];
    const step = Math.max(1, size);
    for (let i = 0; i < items.length; i += step) {
      batches.push(items.slice(i, i + step));
    }
    return batches;
  }

  function isItemDownloaded(item) {
    return Boolean(state.downloadHistory[item.id]);
  }

  async function loadDownloadHistory(goodsId) {
    if (!goodsId) {
      state.downloadHistory = {};
      state.historyGoodsId = "";
      return;
    }
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const store = data[HISTORY_KEY] || {};
    state.downloadHistory = store[goodsId] || {};
    state.historyGoodsId = goodsId;
  }

  async function clearDownloadHistoryForGoods(goodsId) {
    if (!goodsId) return;
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const store = data[HISTORY_KEY] || {};
    delete store[goodsId];
    await chrome.storage.local.set({ [HISTORY_KEY]: store });
    state.downloadHistory = {};
    state.historyGoodsId = goodsId;
  }

  /** 勾选结果 + 卖家秀上限，不含「跳过已下载」 */
  function selectedItemsQueued() {
    const picked = [];
    for (const category of CATEGORIES) {
      const items = (state.groups[category.id] || []).filter((item) => state.selected.has(item.id));
      const cap = activeSellerDownloadLimit();
      if (category.id === "sellerShow" && cap > 0) {
        picked.push(...items.slice(0, cap));
      } else {
        picked.push(...items);
      }
    }
    return picked;
  }

  /** 实际进入下载队列的文件 */
  function selectedItemsForDownload() {
    const queued = selectedItemsQueued();
    if (!state.skipDownloaded) return queued;
    return queued.filter((item) => !isItemDownloaded(item));
  }

  function skippedDownloadedCount() {
    if (!state.skipDownloaded) return 0;
    return selectedItemsQueued().filter((item) => isItemDownloaded(item)).length;
  }

  function downloadedCountInList(items) {
    return items.filter((item) => isItemDownloaded(item)).length;
  }

  function sellerShowSelectedCount(items) {
    return items.filter((item) => state.selected.has(item.id)).length;
  }

  function buildAlertMessage() {
    if (!state.isGoodsPage || state.scanReason === "tick") return null;

    const total = allItems().length;
    const sellerCount = (state.groups.sellerShow || []).length;

    if (state.needLogin) {
      return {
        level: "warn",
        text: "当前页面未登录或未加载完整商品数据。请点下方「打开拼多多首页」登录，再在本页刷新并「重新扫描」。同一 Chrome 用户下新开商品标签/窗口无需重复登录。"
      };
    }
    if (total === 0 && !state.hasGoodsData) {
      return {
        level: "warn",
        text: "商品数据尚未就绪。请等待页面加载完成，或向下滚动详情/评价区后点「重新扫描」。"
      };
    }
    if (total === 0) {
      return {
        level: "info",
        text: "暂未识别到可下载素材。若刚打开页面，请稍等几秒；仍为空请点「重新扫描」。"
      };
    }
    if (sellerCount === 0) {
      return {
        level: "info",
        text: "未识别到卖家秀视频。请确认已登录，或在评价区切到「带视频晒单」并滚动加载后，再点「重新扫描」。"
      };
    }
    return null;
  }

  function buildAlertHtml() {
    const alert = buildAlertMessage();
    if (!alert) {
      return `<div id="pdd-dl-alert" class="pdd-dl-alert" hidden></div>`;
    }
    return `<div id="pdd-dl-alert" class="pdd-dl-alert pdd-dl-alert-${alert.level}" role="status">${escapeHtml(alert.text)}</div>`;
  }

  function formatDownloadStatus() {
    const p = state.downloadProgress;
    if (!state.downloading || !p) return state.status;
    const index = Math.min(p.index || 0, p.total || 0);
    const total = p.total || 0;
    if (p.phase === "start") {
      return `准备下载，共 ${total} 个文件…`;
    }
    return `下载中 ${index}/${total}（成功 ${p.done || 0}，失败 ${p.failed || 0}）`;
  }

  function progressBarHtml() {
    if (!state.downloading || !state.downloadProgress?.total) return "";
    const total = state.downloadProgress.total;
    const index = state.downloadProgress.index || 0;
    const pct = total > 0 ? Math.round((index / total) * 100) : 0;
    return `
      <div class="pdd-dl-progress" aria-hidden="true">
        <div class="pdd-dl-progress-track">
          <div class="pdd-dl-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }

  function setSellerShowSelection(items, predicate) {
    items.forEach((item, index) => {
      if (predicate(item, index)) state.selected.add(item.id);
      else state.selected.delete(item.id);
    });
  }

  function ensurePanel() {
    if (panelShadow) return;

    const host = document.createElement("aside");
    host.id = "pdd-dl-host";
    panelShadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = chrome.runtime.getURL("panel.css");
    panelShadow.appendChild(style);

    const root = document.createElement("div");
    root.id = "pdd-dl-root";
    root.innerHTML = `
      <button id="pdd-dl-toggle" type="button">素材下载</button>
      <section id="pdd-dl-panel" hidden>
        <header class="pdd-dl-header">
          <div>
            <strong>多多商品素材下载器</strong>
            <p id="pdd-dl-meta">正在识别当前页面…</p>
          </div>
          <button id="pdd-dl-close" type="button">收起</button>
        </header>
        <div id="pdd-dl-alert-slot"></div>
        <div id="pdd-dl-scroll">
          <p class="pdd-dl-note">原图原视频，不二次压缩。卖家秀可分组勾选；默认跳过本商品已下载过的同一视频地址。</p>
          <div class="pdd-dl-toolbar">
            <label><input id="pdd-dl-all" type="checkbox" checked /> 全选</label>
            <label class="pdd-dl-skip-label"><input id="pdd-dl-skip-done" type="checkbox" checked /> 跳过已下载</label>
          </div>
          <p class="pdd-dl-history-meta" id="pdd-dl-history-meta"></p>
          <button id="pdd-dl-clear-history" type="button" class="pdd-dl-clear-history">清除本商品下载记录</button>
          <button id="pdd-dl-open-home" type="button" class="pdd-dl-open-home">打开拼多多首页（登录 / 入口）</button>
          <button id="pdd-dl-rescan" class="pdd-dl-rescan" type="button">重新扫描本页</button>
          <div id="pdd-dl-groups"></div>
        </div>
        <footer class="pdd-dl-footer">
          <div id="pdd-dl-progress-slot"></div>
          <button id="pdd-dl-download" type="button">下载已选</button>
          <button id="pdd-dl-stop" type="button" class="pdd-dl-stop" hidden>停止下载</button>
          <p id="pdd-dl-status"></p>
        </footer>
      </section>
    `;
    panelShadow.appendChild(root);
    document.documentElement.appendChild(host);

    $("pdd-dl-toggle").addEventListener("click", () => setOpen(true));
    $("pdd-dl-close").addEventListener("click", () => setOpen(false));
    $("pdd-dl-all").addEventListener("change", (event) => {
      toggleAll(event.target.checked);
      render();
    });
    $("pdd-dl-skip-done").addEventListener("change", (event) => {
      state.skipDownloaded = event.target.checked;
      render();
    });
    $("pdd-dl-clear-history").addEventListener("click", async () => {
      if (!state.goodsId) {
        state.status = "当前没有商品 ID，无法清除记录";
        render();
        return;
      }
      await clearDownloadHistoryForGoods(state.goodsId);
      state.status = "已清除本商品的下载记录，可重新下载全部";
      render();
    });
    $("pdd-dl-open-home").addEventListener("click", () => openPddHome());
    $("pdd-dl-rescan").addEventListener("click", () => {
      state.status = "正在重新扫描…";
      render();
      requestScan();
    });
    $("pdd-dl-download").addEventListener("click", startDownload);
    $("pdd-dl-stop").addEventListener("click", stopDownload);
    setOpen(true);
  }

  function setOpen(open) {
    const panel = $("pdd-dl-panel");
    const toggle = $("pdd-dl-toggle");
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.hidden = open;
  }

  function toggleAll(checked) {
    state.selected.clear();
    if (checked) allItems().forEach((item) => state.selected.add(item.id));
  }

  function syncAllCheckbox() {
    const box = $("pdd-dl-all");
    if (!box) return;
    const items = allItems();
    box.checked = items.length > 0 && items.every((item) => state.selected.has(item.id));
    box.indeterminate = !box.checked && items.some((item) => state.selected.has(item.id));
  }

  function renderSellerShowBody(items, open) {
    if (!items.length) {
      return `<p class="pdd-dl-empty">暂未识别到</p>`;
    }
    if (!open) return "";

    const batchSize = clampBatchSize(state.sellerShowBatchSize);
    const batches = chunkItems(items, batchSize);
    const selectedCount = sellerShowSelectedCount(items);
    const limit = activeSellerDownloadLimit();
    const effective = limit > 0 ? Math.min(selectedCount, limit) : selectedCount;
    const limitEnabled = state.sellerShowLimitEnabled;

    const batchRows = batches
      .map((batch, index) => {
        const start = index * batchSize + 1;
        const end = index * batchSize + batch.length;
        const batchSelected = batch.filter((item) => state.selected.has(item.id)).length;
        const batchDone = downloadedCountInList(batch);
        const allChecked = batch.length > 0 && batchSelected === batch.length;
        return `
          <label class="pdd-dl-batch">
            <input type="checkbox" data-seller-batch="${index}" ${allChecked ? "checked" : ""} />
            <span>第 ${index + 1} 组 · 第 ${start}–${end} 个（勾 ${batchSelected}/${batch.length}${batchDone ? `，已下 ${batchDone}` : ""}）</span>
          </label>
        `;
      })
      .join("");

    return `
      <div class="pdd-dl-batch-panel">
        <div class="pdd-dl-summary pdd-dl-summary-inline">
          共 <strong>${items.length}</strong> 个视频，已勾选 <strong>${selectedCount}</strong> 个
          ${limit > 0 ? `，本次将下载 <strong>${effective}</strong> 个` : ""}。
        </div>
        <div class="pdd-dl-batch-settings">
          <div class="pdd-dl-field-row">
            <span class="pdd-dl-field-label">每组数量</span>
            <input
              class="pdd-dl-num-input"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              autocomplete="off"
              data-seller-batch-size
              value="${batchSize}"
              aria-label="每组数量"
            />
          </div>
          <div class="pdd-dl-field-row pdd-dl-field-row-limit">
            <label class="pdd-dl-limit-enable">
              <input type="checkbox" data-seller-limit-enable ${limitEnabled ? "checked" : ""} />
              <span>限制本次最多下载</span>
            </label>
            <input
              class="pdd-dl-num-input"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              autocomplete="off"
              data-seller-download-limit
              value="${limitEnabled && state.sellerShowDownloadLimit ? state.sellerShowDownloadLimit : ""}"
              placeholder="不限"
              aria-label="本次最多下载"
              ${limitEnabled ? "" : "disabled"}
            />
          </div>
        </div>
        <div class="pdd-dl-batch-actions">
          <button type="button" data-seller-pick-first>只勾选前 N 个</button>
          <button type="button" data-seller-clear>清空卖家秀勾选</button>
        </div>
        <div class="pdd-dl-batch-list">${batchRows}</div>
      </div>
    `;
  }

  function renderCategoryBody(category, items, selectedCount, open) {
    if (!items.length) {
      return `<p class="pdd-dl-empty">暂未识别到</p>`;
    }

    if (category.id === "sellerShow") {
      return renderSellerShowBody(items, open);
    }

    const compact = items.length >= COMPACT_THRESHOLD;
    if (compact) {
      return `
        <div class="pdd-dl-summary">
          共 <strong>${items.length}</strong> 个${items[0].kind === "video" ? "视频" : "文件"}，
          已选 <strong>${selectedCount}</strong> 个。<br />
          列表过长未展示缩略图；勾选上方分类可全选或取消。
        </div>
      `;
    }

    if (!open) return "";

    const previews = items.slice(0, PREVIEW_LIMIT).map((item) => {
      const checked = state.selected.has(item.id) ? "checked" : "";
      const thumb =
        item.kind === "video"
          ? `<span class="pdd-dl-video-flag">视频</span>`
          : `<img src="${escapeAttr(item.url)}" alt="" referrerpolicy="no-referrer" loading="lazy" />`;
      return `
        <label class="pdd-dl-item">
          <input type="checkbox" data-item="${escapeAttr(item.id)}" ${checked} />
          <span class="pdd-dl-thumb">${thumb}</span>
        </label>
      `;
    }).join("");

    const extra =
      items.length > PREVIEW_LIMIT
        ? `<p class="pdd-dl-more">预览 ${PREVIEW_LIMIT} 个，另有 ${items.length - PREVIEW_LIMIT} 个已计入下载</p>`
        : "";

    return `${previews}${extra}`;
  }

  function render() {
    ensurePanel();
    const meta = $("pdd-dl-meta");
    const groupsEl = $("pdd-dl-groups");
    const status = $("pdd-dl-status");
    const downloadBtn = $("pdd-dl-download");
    const alertSlot = $("pdd-dl-alert-slot");
    const progressSlot = $("pdd-dl-progress-slot");
    if (!meta || !groupsEl) return;

    if (alertSlot) alertSlot.innerHTML = buildAlertHtml();

    if (!state.isGoodsPage) {
      meta.textContent = "请打开拼多多商品页或评价页";
    } else {
      const title = (state.title || "未命名商品").slice(0, 36);
      const suffix = (state.title || "").length > 36 ? "…" : "";
      const idText = state.goodsId ? `ID ${state.goodsId}` : "";
      meta.textContent = `${title}${suffix}${idText ? " · " + idText : ""}`;
    }

    groupsEl.innerHTML = CATEGORIES.map((category) => {
      const items = state.groups[category.id] || [];
      const selectedCount = items.filter((item) => state.selected.has(item.id)).length;
      const doneCount = downloadedCountInList(items);
      const open = state.openGroups.has(category.id);
      const groupChecked = items.length > 0 && selectedCount === items.length;
      const body = renderCategoryBody(category, items, selectedCount, open);
      const doneSuffix = doneCount > 0 ? `，已下 ${doneCount}` : "";

      return `
        <section class="pdd-dl-group" data-group="${category.id}">
          <div class="pdd-dl-group-head">
            <label>
              <input type="checkbox" data-group-check="${category.id}" ${groupChecked ? "checked" : ""} ${items.length ? "" : "disabled"} />
              <span>${escapeHtml(category.title)}（${selectedCount}/${items.length}${doneSuffix}）</span>
            </label>
            <button type="button" data-group-toggle="${category.id}">${open ? "收起" : "展开"}</button>
          </div>
          <p class="pdd-dl-hint">${escapeHtml(category.hint)}</p>
          <div class="pdd-dl-items ${category.id === "sellerShow" ? "pdd-dl-items-batch" : ""}" ${open ? "" : "hidden"}>${body}</div>
        </section>
      `;
    }).join("");

    groupsEl.querySelectorAll("[data-group-check]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const category = event.target.getAttribute("data-group-check");
        (state.groups[category] || []).forEach((item) => {
          if (event.target.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
        });
        render();
      });
    });

    groupsEl.querySelectorAll("[data-group-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const category = button.getAttribute("data-group-toggle");
        if (state.openGroups.has(category)) state.openGroups.delete(category);
        else state.openGroups.add(category);
        render();
      });
    });

    groupsEl.querySelectorAll("[data-item]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const id = event.target.getAttribute("data-item");
        if (event.target.checked) state.selected.add(id);
        else state.selected.delete(id);
        render();
      });
    });

    const sellerItems = state.groups.sellerShow || [];
    const sellerBatchSize = clampBatchSize(state.sellerShowBatchSize);
    const sellerBatches = chunkItems(sellerItems, sellerBatchSize);

    groupsEl.querySelectorAll("[data-seller-batch]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const index = parseInt(event.target.getAttribute("data-seller-batch"), 10);
        const batch = sellerBatches[index] || [];
        batch.forEach((item) => {
          if (event.target.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
        });
        render();
      });
    });

    const batchSizeInput = groupsEl.querySelector("[data-seller-batch-size]");
    if (batchSizeInput) {
      batchSizeInput.addEventListener("input", (event) => {
        const raw = digitsOnly(event.target.value);
        event.target.value = raw;
        if (raw) {
          state.sellerShowBatchSize = parsePositiveInt(raw, 1, MAX_SELLER_BATCH);
        }
      });
      batchSizeInput.addEventListener("blur", (event) => {
        const next = parsePositiveInt(event.target.value, 1, MAX_SELLER_BATCH);
        state.sellerShowBatchSize = next;
        event.target.value = String(next);
        render();
      });
      batchSizeInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.target.blur();
      });
    }

    const limitEnable = groupsEl.querySelector("[data-seller-limit-enable]");
    const limitInput = groupsEl.querySelector("[data-seller-download-limit]");
    if (limitEnable) {
      limitEnable.addEventListener("change", (event) => {
        state.sellerShowLimitEnabled = event.target.checked;
        if (!state.sellerShowLimitEnabled) {
          state.sellerShowDownloadLimit = 0;
        } else if (!state.sellerShowDownloadLimit) {
          state.sellerShowDownloadLimit = clampBatchSize(state.sellerShowBatchSize);
        }
        render();
      });
    }
    if (limitInput) {
      limitInput.addEventListener("input", (event) => {
        if (event.target.disabled) return;
        const raw = digitsOnly(event.target.value);
        event.target.value = raw;
        if (raw) {
          state.sellerShowDownloadLimit = parsePositiveInt(raw, 1, sellerItems.length || MAX_SELLER_BATCH);
        }
      });
      limitInput.addEventListener("blur", (event) => {
        if (event.target.disabled) return;
        const max = sellerItems.length || MAX_SELLER_BATCH;
        const next = parsePositiveInt(event.target.value, 1, max);
        state.sellerShowDownloadLimit = next;
        event.target.value = String(next);
        render();
      });
      limitInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.target.blur();
      });
    }

    const pickFirstBtn = groupsEl.querySelector("[data-seller-pick-first]");
    if (pickFirstBtn) {
      pickFirstBtn.addEventListener("click", () => {
        let n = activeSellerDownloadLimit();
        if (!n) n = clampBatchSize(state.sellerShowBatchSize);
        setSellerShowSelection(sellerItems, (_item, index) => index < n);
        state.sellerShowDownloadLimit = 0;
        state.status = `已勾选卖家秀前 ${n} 个`;
        render();
      });
    }

    const clearSellerBtn = groupsEl.querySelector("[data-seller-clear]");
    if (clearSellerBtn) {
      clearSellerBtn.addEventListener("click", () => {
        sellerItems.forEach((item) => state.selected.delete(item.id));
        state.status = "已清空卖家秀勾选";
        render();
      });
    }

    const skipBox = $("pdd-dl-skip-done");
    if (skipBox) skipBox.checked = state.skipDownloaded;

    const historyMeta = $("pdd-dl-history-meta");
    const recordCount = Object.keys(state.downloadHistory).length;
    if (historyMeta) {
      if (state.goodsId && recordCount > 0) {
        historyMeta.textContent =
          `本商品已有 ${recordCount} 条下载记录（按资源地址识别；若已删本地文件，需清除记录才会再下）`;
      } else {
        historyMeta.textContent = "";
      }
    }

    const picked = selectedItemsForDownload().length;
    const skipped = skippedDownloadedCount();
    const stopBtn = $("pdd-dl-stop");
    downloadBtn.disabled = state.downloading || picked === 0;
    if (state.downloading && state.downloadProgress?.total) {
      const idx = state.downloadProgress.index || 0;
      downloadBtn.textContent = `下载中 ${idx}/${state.downloadProgress.total}`;
    } else if (skipped > 0) {
      downloadBtn.textContent = `下载已选（${picked}，跳过已下 ${skipped}）`;
    } else {
      downloadBtn.textContent = state.downloading ? "正在下载…" : `下载已选（${picked}）`;
    }
    if (stopBtn) stopBtn.hidden = !state.downloading;
    if (progressSlot) progressSlot.innerHTML = progressBarHtml();
    if (status) {
      if (!state.downloading && picked === 0 && selectedItemsQueued().length > 0 && state.skipDownloaded) {
        status.textContent = "所选均已下载过：可取消「跳过已下载」，或点「清除本商品下载记录」";
      } else {
        status.textContent = formatDownloadStatus();
      }
    }
    syncAllCheckbox();
  }

  async function applyPayload(payload) {
    if (!payload) return;

    const incomingGoodsId = normalizeGoodsId(payload.goodsId);
    const goodsChanged = Boolean(incomingGoodsId && incomingGoodsId !== state.goodsId);

    if (payload.reason === "tick") {
      state.title = payload.title || state.title;
      state.isGoodsPage = Boolean(payload.isGoodsPage);
      state.needLogin = Boolean(payload.needLogin);
      state.hasGoodsData = Boolean(payload.hasGoodsData);
      state.scanReason = "tick";
      state.groups = payload.groups || emptyGroups();
      if (goodsChanged) {
        state.goodsId = incomingGoodsId;
        await syncGoodsContext(incomingGoodsId, true);
      }
      if (!isEditingSellerNumericInput()) render();
      return;
    }

    const previous = new Set(state.selected);
    const oldIds = new Set(allItems().map((item) => item.id));

    state.title = payload.title || state.title;
    state.isGoodsPage = Boolean(payload.isGoodsPage);
    state.needLogin = Boolean(payload.needLogin);
    state.hasGoodsData = Boolean(payload.hasGoodsData);
    state.scanReason = payload.reason || "";
    state.groups = payload.groups || emptyGroups();
    state.goodsId = incomingGoodsId || state.goodsId;

    if (goodsChanged) {
      await syncGoodsContext(incomingGoodsId, true);
    } else {
      mergeSelectionAfterRescan(previous, oldIds);
      await syncGoodsContext(incomingGoodsId, false);
    }

    updateScanStatus();
    render();
  }

  async function stopDownload() {
    if (!state.downloading) return;
    state.status = "正在停止…";
    render();
    try {
      await chrome.runtime.sendMessage({ type: "pdd-dl-cancel" });
      state.status = "已请求停止";
    } catch (error) {
      state.status = `停止失败：${error.message || error}`;
    }
    render();
  }

  async function startDownload() {
    const items = selectedItemsForDownload();
    if (!items.length || state.downloading) return;
    state.downloading = true;
    state.downloadProgress = { index: 0, total: items.length, done: 0, failed: 0, phase: "start" };
    state.status = `开始下载 ${items.length} 个文件…`;
    render();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "pdd-dl-download",
        items,
        goodsId: state.goodsId,
        title: state.title
      });
      if (response?.stopped) {
        state.status = `已停止：完成 ${response.done} 个，跳过 ${response.cancelled || 0} 个`;
      } else if (response?.ok) {
        state.status = `下载完成：${response.done} 个`;
      } else {
        state.status = `完成 ${response?.done || 0} 个，失败 ${response?.failed || 0} 个`;
      }
    } catch (error) {
      state.status = `下载失败：${error.message || error}`;
    } finally {
      state.downloading = false;
      state.downloadProgress = null;
      await loadDownloadHistory(state.goodsId);
      render();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.direction !== "page-to-ext") return;
    if (data.type === "extract-result") void applyPayload(data.payload);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "pdd-dl-progress") {
      if (state.downloading) {
        state.downloadProgress = {
          index: message.index,
          total: message.total,
          done: message.done,
          failed: message.failed,
          phase: message.phase
        };
        render();
      }
      return;
    }
    if (message?.type === "pdd-dl-get-state") {
      sendResponse({
        title: state.title,
        goodsId: state.goodsId,
        isGoodsPage: state.isGoodsPage,
        needLogin: state.needLogin,
        counts: Object.fromEntries(CATEGORIES.map((category) => [category.id, (state.groups[category.id] || []).length])),
        selected: selectedItemsForDownload().length
      });
      return;
    }
    if (message?.type === "pdd-dl-scan") {
      ensurePanel();
      setOpen(true);
      requestScan();
      sendResponse({ ok: true });
    }
    if (message?.type === "pdd-dl-open-panel") {
      ensurePanel();
      setOpen(true);
      sendResponse({ ok: true });
    }
  });

  ensurePanel();
  render();
  requestScan();
  void loadDownloadHistory("").then(() => render());
})();
