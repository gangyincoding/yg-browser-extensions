(() => {
  if (window.__pddDlInjected) return;
  window.__pddDlInjected = true;

  const SOURCE = "pdd-dl";
  const seen = new Map();
  const extraVideos = [];
  let lastPayload = null;
  let reviewFetchToken = 0;

  const VIDEO_RE = /\.(mp4|mov|m3u8|m4v|webm)(?:$|[?#]|\.f\d+\.mp4)/i;
  const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)(?:$|[?#])/i;
  const MEDIA_HOST_RE = /pddpic|yangkeduo|pinduoduo|pddugc|pddpic\.com/i;
  const SKIP_RE = /avatar|headimg|logo|icon|sprite|emoji|qrcode|captcha|favicon|pixel|tracker|blank\.gif|1x1/i;

  const CATEGORY_KEYS = {
    main: /top.?gallery|carousel.?gallery|gallery_url|hd_url|hdthumb|hd_thumb|main.?image|goods.?gallery|view_image/i,
    sku: /sku/i,
    detailImage: /detail.?gallery|desc.?gallery|decoration|rich.?text|goods.?desc|desc_url|detail.?image/i,
    detailVideo: /video.?gallery|video_url|videourl|goods.?video|detail.?video|main.?video/i,
    sellerShow: /seller.?show|mall.?show|buyer.?show|review.?video|comment.?video|ugc|评价|晒单|卖家秀|买家秀|show_video|live_replay/i
  };

  function post(type, payload) {
    window.postMessage({ source: SOURCE, direction: "page-to-ext", type, payload }, "*");
  }

  function absUrl(value) {
    if (!value || typeof value !== "string") return "";
    let url = value.trim().replace(/\\u002F/g, "/");
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return "";
    if (url.startsWith("//")) url = `${location.protocol}${url}`;
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function isMediaUrl(url) {
    if (!url) return false;
    if (SKIP_RE.test(url)) return false;
    if (VIDEO_RE.test(url) || IMAGE_RE.test(url)) return true;
    if (MEDIA_HOST_RE.test(url) && /\/(mms-material|mms-goods|goods|garner|video|review_video|ugc|open-gw|review)/i.test(url)) return true;
    return false;
  }

  function isVideoUrl(url) {
    return VIDEO_RE.test(url) || /\/video\//i.test(url) || /\/review_video\//i.test(url);
  }

  function toOriginalUrl(url) {
    const raw = absUrl(url);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:") parsed.protocol = "https:";

      const keep = new URLSearchParams();
      for (const [key, value] of parsed.searchParams) {
        if (/^(sign|signature|expires?|e|token|auth|key|k|t|uid|id)$/i.test(key)) {
          keep.append(key, value);
        }
      }

      if (isVideoUrl(parsed.href)) {
        parsed.search = keep.toString();
        return parsed.href;
      }

      parsed.search = "";
      parsed.hash = "";
      return parsed.href;
    } catch {
      return raw.split("#")[0];
    }
  }

  function extFromUrl(url, fallback) {
    const match = url.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    if (match) return match[1].toLowerCase();
    return fallback;
  }

  function fingerprint(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    } catch {
      return url.split("?")[0].toLowerCase();
    }
  }

  function classify(keyPath, url) {
    const path = String(keyPath || "").toLowerCase();
    const video = isVideoUrl(url);

    if (CATEGORY_KEYS.sellerShow.test(path)) return video ? "sellerShow" : "sellerShowImage";
    if (video && CATEGORY_KEYS.detailVideo.test(path)) return "detailVideo";
    if (video && /review|comment|ugc|评价|晒/.test(path)) return "sellerShow";
    if (video) return "detailVideo";
    if (CATEGORY_KEYS.sku.test(path) && /thumb|url|image|img|pic/i.test(path)) return "sku";
    if (CATEGORY_KEYS.detailImage.test(path)) return "detailImage";
    if (CATEGORY_KEYS.main.test(path)) return "main";
    if (CATEGORY_KEYS.sku.test(path)) return "sku";
    return video ? "detailVideo" : "";
  }

  function addItem(category, url, label) {
    const original = toOriginalUrl(url);
    if (!original || !isMediaUrl(original)) return;
    const id = `${category}:${fingerprint(original)}`;
    if (seen.has(id)) return;

    const video = isVideoUrl(original);
    const item = {
      id,
      category,
      url: original,
      label: label || "",
      kind: video ? "video" : "image",
      ext: extFromUrl(original, video ? "mp4" : "jpg")
    };
    seen.set(id, item);
  }

  function collectFromValue(value, keyPath) {
    if (value == null) return;

    if (typeof value === "string") {
      if (value.includes(",") && /https?:\/\//.test(value) && value.length > 80) {
        value.split(",").forEach((part) => collectFromValue(part.trim(), keyPath));
        return;
      }
      const url = toOriginalUrl(value);
      if (!url || !isMediaUrl(url)) return;
      const category = classify(keyPath, url);
      if (category) addItem(category, url);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => collectFromValue(item, `${keyPath}[${index}]`));
      return;
    }

    if (typeof value !== "object") return;

    if (value.review_id && value.video && typeof value.video === "object") {
      const reviewLabel = typeof value.name === "string" ? value.name : "";
      if (typeof value.video.url === "string") addItem("sellerShow", value.video.url, reviewLabel);
      else if (typeof value.video.transcoded_url === "string") addItem("sellerShow", value.video.transcoded_url, reviewLabel);
    }

    const preferred =
      value.video_url ||
      value.videoUrl ||
      value.url ||
      value.hd_url ||
      value.hdUrl ||
      value.image_url ||
      value.imageUrl ||
      value.thumbUrl ||
      value.thumb_url ||
      value.src;
    if (typeof preferred === "string") {
      collectFromValue(preferred, keyPath);
    }

    const label = [value.spec_value, value.specValue, value.name, value.goods_name, value.goodsName]
      .filter((part) => typeof part === "string" && part.trim())
      .join("-");

    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object" || typeof child === "string") {
        collectFromValue(child, `${keyPath}.${key}`);
      }
    }

    if (label && preferred) {
      const url = toOriginalUrl(preferred);
      const category = classify(keyPath, url);
      if (category && seen.has(`${category}:${fingerprint(url)}`)) {
        seen.get(`${category}:${fingerprint(url)}`).label = label;
      }
    }
  }

  function pickGoodsNode(data) {
    if (!data || typeof data !== "object") return null;
    const goods =
      data.store?.initDataObj?.goods ||
      data.initDataObj?.goods ||
      data.goods ||
      data.data?.goods ||
      data.itemInfo?.item;
    return goods || null;
  }

  function extractAuthState(data) {
    const init = data?.store?.initDataObj || data?.initDataObj || {};
    const needLogin = init.needLogin === true;
    const goods = pickGoodsNode(data);
    const hasGoodsData = Boolean(
      goods &&
        (goods.goodsID ||
          goods.goodsId ||
          goods.goods_id ||
          goods.viewImageData ||
          goods.detailGallery ||
          goods.gallery ||
          goods.skus)
    );
    return { needLogin, hasGoodsData };
  }

  function extractMeta(data) {
    const goods = pickGoodsNode(data) || {};
    const params = new URLSearchParams(location.search);
    const title =
      goods.goodsName ||
      goods.goods_name ||
      goods.goods_name ||
      goods.tiny_name ||
      goods.title ||
      document.title.replace(/[-_]?拼多多.*$/, "").trim();
    const goodsId =
      String(goods.goodsID || goods.goodsId || goods.goods_id || params.get("goods_id") || "") ||
      (location.pathname.match(/goods[_/](\d+)/i) || [])[1] ||
      "";
    return { title, goodsId };
  }

  function isPddGoodsContext() {
    return /goods\d*\.html|goods_comments\.html|goods_id=/i.test(location.href);
  }

  async function fetchReviewMedia(goodsId, reason) {
    if (!goodsId || !isPddGoodsContext()) return;
    const token = ++reviewFetchToken;
    const buildUrl = (id, qs) => `https://mobile.yangkeduo.com/proxy/api/reviews/${id}/list?${qs}`;
    const labelIds = ["600000000", "0"];

    for (const labelId of labelIds) {
      for (let page = 1; page <= 15; page += 1) {
        if (token !== reviewFetchToken) return;
        const qs = new URLSearchParams({
          page: String(page),
          size: "20",
          enable_video: "1",
          enable_group_review: "1",
          label_id: labelId
        }).toString();
        try {
          const res = await fetch(buildUrl(goodsId, qs), { credentials: "include" });
          if (!res.ok) break;
          const json = await res.json();
          const list = json.data || json.reviews || json.result?.reviews || json.list;
          if (!Array.isArray(list) || !list.length) break;
          collectFromValue(json, `reviews.${reason}.label${labelId}.page${page}`);
          publish("reviews");
          if (list.length < 20) break;
        } catch (_) {
          break;
        }
      }
    }
  }

  function collectFromPageUrl() {
    const params = new URLSearchParams(location.search);
    ["_oak_gallery", "oak_gallery", "thumb_url", "hd_thumb_url", "hd_url"].forEach((key) => {
      const value = params.get(key);
      if (value) addItem("main", value, "链接封面");
    });
  }

  function scanDom() {
    document.querySelectorAll("video").forEach((video, index) => {
      const url = video.currentSrc || video.src || video.getAttribute("src");
      if (!url) return;
      const category = index === 0 ? "detailVideo" : "sellerShow";
      addItem(category, url, video.getAttribute("aria-label") || "");
    });

    document.querySelectorAll("source[src]").forEach((source) => {
      const url = source.getAttribute("src");
      if (isVideoUrl(url || "")) addItem("sellerShow", url);
    });

    document.querySelectorAll("img").forEach((img) => {
      const url = img.currentSrc || img.src || img.dataset.src || img.getAttribute("data-src");
      if (!url || !isMediaUrl(url)) return;
      const wrap = `${img.className} ${img.parentElement?.className || ""} ${img.alt || ""}`;
      if (/sku/i.test(wrap)) addItem("sku", url, img.alt || "");
      else if (/detail|desc|rich/i.test(wrap)) addItem("detailImage", url);
      else if (/swiper|gallery|banner|main|top/i.test(wrap)) addItem("main", url);
    });
  }

  function buildPayload() {
    extraVideos.forEach((url) => {
      if (!seen.has(`detailVideo:${fingerprint(url)}`)) addItem("sellerShow", url);
    });

    const data = window.rawData || window.__INITIAL_STATE__ || null;
    if (data) collectFromValue(data, "rawData");
    collectFromPageUrl();
    scanDom();

    const meta = extractMeta(data);
    const auth = extractAuthState(data);
    const groups = {
      main: [],
      sku: [],
      detailImage: [],
      detailVideo: [],
      sellerShow: []
    };

    for (const item of seen.values()) {
      if (item.category === "sellerShowImage") continue;
      if (groups[item.category]) groups[item.category].push(item);
    }

    lastPayload = {
      pageUrl: location.href,
      isGoodsPage: isPddGoodsContext(),
      title: meta.title || "拼多多商品",
      goodsId: meta.goodsId,
      needLogin: auth.needLogin,
      hasGoodsData: auth.hasGoodsData,
      groups,
      scannedAt: Date.now()
    };
    return lastPayload;
  }

  function publish(reason) {
    post("extract-result", { ...buildPayload(), reason });
  }

  function hookNetwork() {
    const rawFetch = window.fetch;
    if (typeof rawFetch === "function") {
      window.fetch = async function (...args) {
        const response = await rawFetch.apply(this, args);
        try {
          const cloned = response.clone();
          const url = String(args[0]?.url || args[0] || "");
          maybeIngest(url, cloned);
        } catch (_) {}
        return response;
      };
    }

    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__pddDlUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          maybeIngest(this.__pddDlUrl || "", this.responseText);
        } catch (_) {}
      });
      return rawSend.apply(this, args);
    };
  }

  function maybeIngest(url, body) {
    const href = String(url || "");
    if (!/goods|review|comment|oak|render|detail|video|gallery|ugc|show|proxy/i.test(href) && typeof body !== "string") {
      if (typeof body?.text !== "function") return;
    }

    const handleText = (text) => {
      if (!text || text.length < 20 || text.length > 8_000_000) return;
      if (text[0] !== "{" && text[0] !== "[") return;
      try {
        const json = JSON.parse(text);
        collectFromValue(json, `api:${href}`);
        publish("network");
      } catch (_) {}
    };

    if (typeof body === "string") {
      handleText(body);
      return;
    }
    if (body && typeof body.text === "function") {
      body.text().then(handleText).catch(() => {});
    }
  }

  function watchRawData() {
    let current = window.rawData;
    Object.defineProperty(window, "rawData", {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(value) {
        current = value;
        collectFromValue(value, "rawData");
        publish("rawData");
      }
    });
    if (current) {
      collectFromValue(current, "rawData");
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.direction !== "ext-to-page") return;
    if (data.type === "scan") {
      const goodsId = extractMeta(window.rawData).goodsId;
      fetchReviewMedia(goodsId, "manual").finally(() => publish("manual"));
    }
  });

  hookNetwork();
  try {
    watchRawData();
  } catch (_) {
    if (window.rawData) collectFromValue(window.rawData, "rawData");
  }

  const boot = () => {
    publish("boot");
    const goodsId = extractMeta(window.rawData).goodsId;
    fetchReviewMedia(goodsId, "boot");
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    if (window.rawData) collectFromValue(window.rawData, "rawData");
    publish("tick");
    if (ticks >= 40) clearInterval(timer);
  }, 1500);

  document.addEventListener(
    "play",
    (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const url = video.currentSrc || video.src;
      if (url) {
        extraVideos.push(url);
        addItem("sellerShow", url);
        publish("play");
      }
    },
    true
  );
})();
