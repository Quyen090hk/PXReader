(() => {
  "use strict";

  const DB_NAME = "p5reader";
  const DB_VERSION = 1;
  const STORE_BOOKS = "books";
  const PROGRESS_PREFIX = "p5reader:progress:";
  const ANNOTATION_PREFIX = "p5reader:annotations:";
  const THEME_KEY = "p5reader:theme";
  const LAYOUT_KEY = "p5reader:layout";
  const ZOOM_KEY = "p5reader:zoom";
  const RAILS_KEY = "p5reader:rails";
  const SUPPORTED_TYPES = new Set(["epub", "txt", "pdf"]);
  const ANNOTATION_COLORS = ["#ffd84a", "#7bdff2", "#b2f7a4", "#ff9eb5"];
  const DEFAULT_ANNOTATION_COLOR = ANNOTATION_COLORS[0];

  const $ = (selector) => document.querySelector(selector);

  const els = {
    bookInput: $("#bookInput"),
    themeSelect: $("#themeSelect"),
    layoutSelect: $("#layoutSelect"),
    toggleLibraryBtn: $("#toggleLibraryBtn"),
    toggleToolsBtn: $("#toggleToolsBtn"),
    focusModeBtn: $("#focusModeBtn"),
    zoomOutBtn: $("#zoomOutBtn"),
    zoomInBtn: $("#zoomInBtn"),
    zoomResetBtn: $("#zoomResetBtn"),
    zoomLabel: $("#zoomLabel"),
    libraryList: $("#libraryList"),
    libraryCount: $("#libraryCount"),
    tocList: $("#tocList"),
    tocCount: $("#tocCount"),
    readerViewport: $("#readerViewport"),
    bookTitle: $("#bookTitle"),
    bookFormat: $("#bookFormat"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    progressFill: $("#progressFill"),
    progressLabel: $("#progressLabel"),
    locationLabel: $("#locationLabel"),
    searchForm: $("#searchForm"),
    searchInput: $("#searchInput"),
    rebuildIndexBtn: $("#rebuildIndexBtn"),
    searchStatus: $("#searchStatus"),
    searchResults: $("#searchResults"),
    searchCount: $("#searchCount"),
    annotationCount: $("#annotationCount"),
    annotationList: $("#annotationList"),
    annotationComposer: $("#annotationComposer"),
    annotationQuote: $("#annotationQuote"),
    annotationNote: $("#annotationNote"),
    annotationSaveHighlight: $("#annotationSaveHighlight"),
    annotationSaveNote: $("#annotationSaveNote"),
    annotationCancel: $("#annotationCancel"),
    annotationColors: $("#annotationColors"),
    toast: $("#toast"),
  };

  const state = {
    db: null,
    library: [],
    activeBookRecord: null,
    adapter: null,
    location: null,
    toc: [],
    annotations: [],
    pendingSelection: null,
    selectedAnnotationColor: DEFAULT_ANNOTATION_COLOR,
    renderToken: 0,
    scrollFrame: 0,
    resizeFrame: 0,
    libraryFrame: 0,
    turnTimer: 0,
    turnDirection: "",
    pagedMetrics: { pagesPerSpread: 1, pageWidth: 0, pageGap: 0, spreadStep: 0 },
    indexToken: 0,
    indexBookId: null,
    indexReady: false,
    searchClient: null,
    layoutMode: localStorage.getItem(LAYOUT_KEY) || "scroll",
    zoom: clamp(Number(localStorage.getItem(ZOOM_KEY)) || 1, 0.75, 2.25),
    rails: loadRailState(),
  };

  class BookStore {
    constructor(db) {
      this.db = db;
    }

    static open() {
      if (!("indexedDB" in window)) {
        return Promise.resolve(null);
      }

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_BOOKS)) {
            const store = db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
            store.createIndex("addedAt", "addedAt");
            store.createIndex("title", "title");
          }
        };

        request.onsuccess = () => resolve(new BookStore(request.result));
        request.onerror = () => reject(request.error);
      });
    }

    transaction(mode = "readonly") {
      return this.db.transaction(STORE_BOOKS, mode).objectStore(STORE_BOOKS);
    }

    put(record) {
      return new Promise((resolve, reject) => {
        const request = this.transaction("readwrite").put(record);
        request.onsuccess = () => resolve(record);
        request.onerror = () => reject(request.error);
      });
    }

    get(id) {
      return new Promise((resolve, reject) => {
        const request = this.transaction().get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    list() {
      return new Promise((resolve, reject) => {
        const request = this.transaction().getAll();
        request.onsuccess = () => {
          const books = request.result || [];
          books.sort((a, b) => b.addedAt - a.addedAt);
          resolve(books);
        };
        request.onerror = () => reject(request.error);
      });
    }
  }

  class SearchIndexClient {
    constructor() {
      this.worker = new Worker("src/search-worker.js");
      this.seq = 0;
      this.pending = new Map();
      this.worker.addEventListener("message", (event) => this.handleMessage(event));
      this.worker.addEventListener("error", (event) => {
        for (const { reject } of this.pending.values()) {
          reject(new Error(event.message || "Search worker failed."));
        }
        this.pending.clear();
      });
    }

    handleMessage(event) {
      const { id, ok, result, error } = event.data || {};
      if (!this.pending.has(id)) return;
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error || "Search worker failed."));
    }

    request(type, payload) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, type, payload });
      });
    }

    build(bookId, units) {
      return this.request("build", { bookId, units });
    }

    search(bookId, query) {
      return this.request("search", { bookId, query });
    }

    terminate() {
      this.worker.terminate();
      this.pending.clear();
    }
  }

  class TxtAdapter {
    constructor(record) {
      this.record = record;
      this.type = "txt";
      this.title = stripExtension(record.name);
      this.chapters = [];
      this.supportsPagination = false;
    }

    async load() {
      const buffer = await this.record.blob.arrayBuffer();
      const text = decodeText(buffer);
      this.chapters = splitTxtChapters(text);
      return {
        title: this.title,
        type: this.type,
        count: this.chapters.length,
      };
    }

    getInitialLocation() {
      return { unit: "chapter", index: 0, ratio: 0 };
    }

    getToc() {
      return this.chapters.map((chapter, index) => ({
        title: chapter.title,
        level: 0,
        location: { unit: "chapter", index, ratio: 0 },
      }));
    }

    async render(location, viewport) {
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      const chapter = this.chapters[index];
      viewport.innerHTML = "";

      const article = document.createElement("article");
      article.className = "book-content txt-content";
      article.dataset.chapterIndex = String(index);
      article.innerHTML = [
        `<h1>${escapeHtml(chapter.title)}</h1>`,
        ...chapter.text
          .split(/\n{2,}/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`),
      ].join("");

      viewport.append(article);
    }

    next(location) {
      const index = clamp((location.index || 0) + 1, 0, this.chapters.length - 1);
      return { unit: "chapter", index, ratio: 0 };
    }

    prev(location) {
      const index = clamp((location.index || 0) - 1, 0, this.chapters.length - 1);
      return { unit: "chapter", index, ratio: 0 };
    }

    isAtStart(location) {
      return (location.index || 0) <= 0;
    }

    isAtEnd(location) {
      return (location.index || 0) >= this.chapters.length - 1;
    }

    getPercentage(location) {
      if (!this.chapters.length) return 0;
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      const ratio = clamp(location.ratio || 0, 0, 1);
      return clamp((index + ratio) / this.chapters.length, 0, 1);
    }

    getLocationLabel(location) {
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      return `第 ${index + 1} / ${this.chapters.length} 章`;
    }

    async getIndexUnits() {
      return this.chapters.map((chapter, index) => ({
        id: String(index),
        title: chapter.title,
        text: chapter.text,
        location: { unit: "chapter", index, ratio: 0 },
      }));
    }

    async search(query) {
      return searchTextUnits(query, await this.getIndexUnits());
    }
  }

  class EpubAdapter {
    constructor(record) {
      this.record = record;
      this.type = "epub";
      this.title = stripExtension(record.name);
      this.zip = null;
      this.opfPath = "";
      this.opfDir = "";
      this.manifest = new Map();
      this.spine = [];
      this.chapters = [];
      this.toc = [];
      this.resourceUrls = new Map();
      this.textCache = new Map();
      this.styleCache = new Map();
      this.supportsPagination = true;
    }

    async load() {
      if (!window.JSZip) {
        throw new Error("EPUB parser is not loaded. Check the JSZip CDN.");
      }

      this.zip = await window.JSZip.loadAsync(this.record.blob);
      this.opfPath = await this.resolveOpfPath();
      this.opfDir = dirname(this.opfPath);
      const opfFile = this.zip.file(this.opfPath);
      if (!opfFile) throw new Error("EPUB package file was not found.");

      const opfText = await opfFile.async("text");
      const opfDoc = parseXml(opfText);
      this.title = readFirstText(opfDoc, "title") || this.title;
      this.readManifest(opfDoc);
      this.readSpine(opfDoc);
      this.toc = await this.readToc(opfDoc);

      return {
        title: this.title,
        type: this.type,
        count: this.chapters.length,
      };
    }

    async resolveOpfPath() {
      const containerFile = this.zip.file("META-INF/container.xml");
      if (!containerFile) throw new Error("Invalid EPUB: missing container.xml.");
      const container = parseXml(await containerFile.async("text"));
      const rootfile = container.getElementsByTagName("rootfile")[0];
      const fullPath = rootfile && rootfile.getAttribute("full-path");
      if (!fullPath) throw new Error("Invalid EPUB: missing rootfile.");
      return fullPath;
    }

    readManifest(opfDoc) {
      this.manifest.clear();
      for (const item of Array.from(opfDoc.getElementsByTagName("item"))) {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");
        if (!id || !href) continue;
        const fullPath = normalizePath(this.opfDir, href);
        this.manifest.set(id, {
          id,
          href,
          fullPath,
          mediaType: item.getAttribute("media-type") || "",
          properties: item.getAttribute("properties") || "",
        });
      }
    }

    readSpine(opfDoc) {
      this.spine = [];
      this.chapters = [];
      for (const itemref of Array.from(opfDoc.getElementsByTagName("itemref"))) {
        const idref = itemref.getAttribute("idref");
        const item = idref && this.manifest.get(idref);
        if (!item) continue;
        if (!/html|xhtml|xml/i.test(item.mediaType) && !/\.(xhtml|html?)$/i.test(item.fullPath)) continue;
        this.spine.push(item);
        this.chapters.push({
          title: item.href.split("/").pop() || `Chapter ${this.chapters.length + 1}`,
          path: item.fullPath,
          index: this.chapters.length,
        });
      }
    }

    async readToc(opfDoc) {
      const navItem = Array.from(this.manifest.values()).find((item) =>
        item.properties.split(/\s+/).includes("nav"),
      );
      if (navItem) {
        const nav = await this.readHtmlToc(navItem.fullPath);
        if (nav.length) return nav;
      }

      const spine = opfDoc.getElementsByTagName("spine")[0];
      const ncxId = spine && spine.getAttribute("toc");
      const ncxItem = ncxId && this.manifest.get(ncxId);
      if (ncxItem) {
        const ncx = await this.readNcxToc(ncxItem.fullPath);
        if (ncx.length) return ncx;
      }

      return this.getFallbackToc();
    }

    async readHtmlToc(path) {
      const file = this.zip.file(path);
      if (!file) return [];
      const html = await file.async("text");
      const doc = new DOMParser().parseFromString(html, "text/html");
      const navs = Array.from(doc.querySelectorAll("nav"));
      const tocNav =
        navs.find((nav) => {
          const type = `${nav.getAttribute("epub:type") || ""} ${nav.getAttribute("type") || ""}`;
          return /\btoc\b/i.test(type);
        }) || navs[0];
      if (!tocNav) return [];

      const items = [];
      const parseOl = (ol, level) => {
        for (const li of Array.from(ol.children).filter((node) => node.tagName.toLowerCase() === "li")) {
          const label = Array.from(li.children).find((node) => /^(a|span)$/i.test(node.tagName));
          const nested = Array.from(li.children).find((node) => node.tagName.toLowerCase() === "ol");
          if (label) {
            const href = label.getAttribute("href") || "";
            const location = this.locationFromHref(normalizePath(dirname(path), href));
            items.push({
              title: collapseWhitespace(label.textContent) || "未命名章节",
              level,
              location,
            });
          }
          if (nested) parseOl(nested, level + 1);
        }
      };

      const firstOl = tocNav.querySelector("ol");
      if (firstOl) parseOl(firstOl, 0);
      return items.filter((item) => item.location);
    }

    async readNcxToc(path) {
      const file = this.zip.file(path);
      if (!file) return [];
      const doc = parseXml(await file.async("text"));
      const items = [];
      const parsePoint = (point, level) => {
        const labelNode = point.getElementsByTagName("text")[0];
        const contentNode = point.getElementsByTagName("content")[0];
        const src = contentNode && contentNode.getAttribute("src");
        if (src) {
          items.push({
            title: collapseWhitespace(labelNode ? labelNode.textContent : "") || "未命名章节",
            level,
            location: this.locationFromHref(normalizePath(dirname(path), src)),
          });
        }
        for (const child of Array.from(point.children).filter((node) => node.tagName === "navPoint")) {
          parsePoint(child, level + 1);
        }
      };

      for (const point of Array.from(doc.getElementsByTagName("navPoint"))) {
        if (point.parentElement && point.parentElement.tagName === "navMap") {
          parsePoint(point, 0);
        }
      }
      return items.filter((item) => item.location);
    }

    getFallbackToc() {
      return this.chapters.map((chapter, index) => ({
        title: chapter.title,
        level: 0,
        location: { unit: "chapter", index, ratio: 0 },
      }));
    }

    getInitialLocation() {
      return { unit: "chapter", index: 0, ratio: 0 };
    }

    getToc() {
      return this.toc.length ? this.toc : this.getFallbackToc();
    }

    locationFromHref(href) {
      const [cleanHref, hash] = href.split("#");
      let index = this.chapters.findIndex((chapter) => chapter.path === cleanHref);
      if (index < 0) {
        index = this.chapters.findIndex((chapter) => chapter.path.endsWith(cleanHref));
      }
      if (index < 0) return null;
      return { unit: "chapter", index, ratio: 0, anchor: hash || "" };
    }

    async render(location, viewport) {
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      const chapter = this.chapters[index];
      const file = this.zip.file(chapter.path);
      if (!file) throw new Error("EPUB chapter file is missing.");

      const doc = new DOMParser().parseFromString(await file.async("text"), "text/html");
      const chapterDir = dirname(chapter.path);
      const scopedStyles = await this.collectStyles(doc, chapterDir);
      sanitizeHtmlDocument(doc);
      await this.rewriteResources(doc, chapterDir);

      viewport.innerHTML = "";
      const article = document.createElement("article");
      article.className = "book-content epub-content";
      article.dataset.chapterIndex = String(index);
      article.innerHTML = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;

      if (scopedStyles) {
        const style = document.createElement("style");
        style.dataset.epubStyle = "true";
        style.textContent = scopedStyles;
        article.prepend(style);
      }

      bindEpubLinks(article, chapterDir, (href) => {
        const target = this.locationFromHref(normalizePath(chapterDir, href));
        if (target) navigateTo(target);
      });

      viewport.append(article);

      const heading = article.querySelector("h1, h2, h3, title");
      if (heading && collapseWhitespace(heading.textContent)) {
        chapter.title = collapseWhitespace(heading.textContent);
      }
    }

    async collectStyles(doc, baseDir) {
      const styleTexts = [];
      const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'));

      for (const link of links) {
        const href = link.getAttribute("href");
        const path = normalizePath(baseDir, href).split("#")[0];
        if (this.styleCache.has(path)) {
          styleTexts.push(this.styleCache.get(path));
          link.remove();
          continue;
        }

        const file = this.zip.file(path);
        if (!file) {
          link.remove();
          continue;
        }
        const css = await this.rewriteCssUrls(await file.async("text"), dirname(path));
        const scoped = scopeCss(css, ".epub-content");
        this.styleCache.set(path, scoped);
        styleTexts.push(scoped);
        link.remove();
      }

      for (const style of Array.from(doc.querySelectorAll("style"))) {
        const css = await this.rewriteCssUrls(style.textContent || "", baseDir);
        styleTexts.push(scopeCss(css, ".epub-content"));
        style.remove();
      }

      return styleTexts.join("\n");
    }

    async rewriteCssUrls(css, baseDir) {
      const matches = Array.from(css.matchAll(/url\((['"]?)([^'")]+)\1\)/gi));
      let rewritten = css;
      for (const match of matches) {
        const raw = match[2].trim();
        if (!raw || /^(data:|https?:|blob:|#)/i.test(raw)) continue;
        const url = await this.resourceUrl(baseDir, raw);
        if (url) rewritten = rewritten.replace(match[0], `url("${url}")`);
      }
      return rewritten;
    }

    async rewriteResources(doc, baseDir) {
      const srcNodes = Array.from(doc.querySelectorAll("[src]"));
      await Promise.all(
        srcNodes.map(async (node) => {
          const src = node.getAttribute("src");
          const url = await this.resourceUrl(baseDir, src);
          if (url) node.setAttribute("src", url);
        }),
      );

      const srcsetNodes = Array.from(doc.querySelectorAll("[srcset]"));
      await Promise.all(
        srcsetNodes.map(async (node) => {
          const value = node.getAttribute("srcset") || "";
          const parts = await Promise.all(
            value.split(",").map(async (entry) => {
              const [src, descriptor] = entry.trim().split(/\s+/, 2);
              const url = await this.resourceUrl(baseDir, src);
              return url ? `${url}${descriptor ? ` ${descriptor}` : ""}` : entry;
            }),
          );
          node.setAttribute("srcset", parts.join(", "));
        }),
      );

      const posterNodes = Array.from(doc.querySelectorAll("[poster]"));
      await Promise.all(
        posterNodes.map(async (node) => {
          const src = node.getAttribute("poster");
          const url = await this.resourceUrl(baseDir, src);
          if (url) node.setAttribute("poster", url);
        }),
      );
    }

    async resourceUrl(baseDir, href) {
      if (!href || /^(https?:|data:|blob:|mailto:|#)/i.test(href)) return href;
      const path = normalizePath(baseDir, href).split("#")[0];
      if (this.resourceUrls.has(path)) return this.resourceUrls.get(path);
      const file = this.zip.file(path);
      if (!file) return "";
      const blob = await file.async("blob");
      const url = URL.createObjectURL(new Blob([blob], { type: mimeFromPath(path) }));
      this.resourceUrls.set(path, url);
      return url;
    }

    next(location) {
      const index = clamp((location.index || 0) + 1, 0, this.chapters.length - 1);
      return { unit: "chapter", index, ratio: 0 };
    }

    prev(location) {
      const index = clamp((location.index || 0) - 1, 0, this.chapters.length - 1);
      return { unit: "chapter", index, ratio: 0 };
    }

    isAtStart(location) {
      return (location.index || 0) <= 0;
    }

    isAtEnd(location) {
      return (location.index || 0) >= this.chapters.length - 1;
    }

    getPercentage(location) {
      if (!this.chapters.length) return 0;
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      const ratio = clamp(location.ratio || 0, 0, 1);
      return clamp((index + ratio) / this.chapters.length, 0, 1);
    }

    getLocationLabel(location) {
      const index = clamp(location.index || 0, 0, this.chapters.length - 1);
      const mode = isPagedMode() ? "分页" : "滚动";
      return `第 ${index + 1} / ${this.chapters.length} 章 · ${mode}`;
    }

    async getChapterText(index) {
      if (this.textCache.has(index)) return this.textCache.get(index);
      const chapter = this.chapters[index];
      const file = this.zip.file(chapter.path);
      if (!file) return "";
      const doc = new DOMParser().parseFromString(await file.async("text"), "text/html");
      const title = collapseWhitespace(doc.querySelector("h1, h2, h3")?.textContent || chapter.title);
      if (title) chapter.title = title;
      const text = collapseWhitespace(doc.body ? doc.body.textContent : doc.documentElement.textContent);
      this.textCache.set(index, text);
      return text;
    }

    async getIndexUnits(onProgress) {
      const units = [];
      for (let index = 0; index < this.chapters.length; index += 1) {
        units.push({
          id: String(index),
          title: this.chapters[index].title,
          text: await this.getChapterText(index),
          location: { unit: "chapter", index, ratio: 0 },
        });
        if (onProgress) onProgress(index + 1, this.chapters.length);
      }
      return units;
    }

    async search(query) {
      return searchTextUnits(query, await this.getIndexUnits());
    }
  }

  class PdfAdapter {
    constructor(record) {
      this.record = record;
      this.type = "pdf";
      this.title = stripExtension(record.name);
      this.pdf = null;
      this.pageCount = 0;
      this.outline = [];
      this.textCache = new Map();
      this.supportsPagination = true;
    }

    async load() {
      if (!window.pdfjsLib) {
        throw new Error("PDF renderer is not loaded. Check the PDF.js CDN.");
      }

      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      const data = new Uint8Array(await this.record.blob.arrayBuffer());
      this.pdf = await window.pdfjsLib.getDocument({ data }).promise;
      this.pageCount = this.pdf.numPages;

      try {
        const meta = await this.pdf.getMetadata();
        this.title = meta.info && meta.info.Title ? meta.info.Title : this.title;
      } catch (_) {
        this.title = this.title;
      }

      this.outline = await this.buildOutline();
      return {
        title: this.title,
        type: this.type,
        count: this.pageCount,
      };
    }

    getInitialLocation() {
      return { unit: "page", page: 1 };
    }

    async buildOutline() {
      const outline = await this.pdf.getOutline();
      if (!outline || !outline.length) {
        return Array.from({ length: this.pageCount }, (_, index) => ({
          title: `第 ${index + 1} 页`,
          level: 0,
          location: { unit: "page", page: index + 1 },
        }));
      }

      const items = [];
      const visit = async (nodes, level) => {
        for (const node of nodes) {
          const page = await this.pageFromDestination(node.dest);
          if (page) {
            items.push({
              title: collapseWhitespace(node.title) || `第 ${page} 页`,
              level,
              location: { unit: "page", page },
            });
          }
          if (node.items && node.items.length) await visit(node.items, level + 1);
        }
      };

      await visit(outline, 0);
      return items.length ? items : [];
    }

    async pageFromDestination(dest) {
      if (!dest) return null;
      const destination = typeof dest === "string" ? await this.pdf.getDestination(dest) : dest;
      if (!destination || !destination[0]) return null;
      try {
        return (await this.pdf.getPageIndex(destination[0])) + 1;
      } catch (_) {
        return null;
      }
    }

    getToc() {
      return this.outline.length
        ? this.outline
        : Array.from({ length: this.pageCount }, (_, index) => ({
            title: `第 ${index + 1} 页`,
            level: 0,
            location: { unit: "page", page: index + 1 },
          }));
    }

    async render(location, viewport, renderContext = {}) {
      const pageNumber = clamp(location.page || 1, 1, this.pageCount);
      const stage = document.createElement("div");
      const isPaged = renderContext.layoutMode === "paged";
      const pagesPerSpread = isPaged ? getPdfPagesPerSpread() : 1;
      const pageNumbers = Array.from({ length: pagesPerSpread }, (_, index) => pageNumber + index).filter(
        (page) => page <= this.pageCount,
      );
      const pages = await Promise.all(pageNumbers.map((page) => this.pdf.getPage(page)));
      const rawViewports = pages.map((page) => page.getViewport({ scale: 1 }));
      const pageGap = isPaged && pageNumbers.length > 1 ? 28 : 0;
      const availableWidth = Math.max(300, viewport.clientWidth - (isPaged ? 80 : 44));
      const availableHeight = Math.max(280, viewport.clientHeight - (isPaged ? 76 : 44));
      const rawWidth = rawViewports.reduce((sum, item) => sum + item.width, 0) + pageGap * Math.max(0, rawViewports.length - 1);
      const rawHeight = Math.max(...rawViewports.map((item) => item.height));
      const fitScale = isPaged ? Math.min(availableWidth / rawWidth, availableHeight / rawHeight) : availableWidth / rawViewports[0].width;
      const scale = clamp(fitScale * (renderContext.zoom || 1), 0.35, 4);

      stage.className = isPaged ? "pdf-stage pdf-spread" : "pdf-stage";
      stage.style.setProperty("--pdf-page-gap", `${pageGap}px`);

      for (let index = 0; index < pages.length; index += 1) {
        const pageWrap = await this.renderPageElement(pages[index], rawViewports[index], scale, pageNumbers[index]);
        stage.append(pageWrap);
      }

      viewport.replaceChildren(stage);
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
    }

    async renderPageElement(page, rawViewport, scale, pageNumber) {
      const renderViewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const pageWrap = document.createElement("div");
      pageWrap.className = "pdf-page";
      pageWrap.dataset.page = String(pageNumber);
      const canvas = document.createElement("canvas");
      const textLayer = document.createElement("div");
      const canvasContext = canvas.getContext("2d", { alpha: false });

      canvas.width = Math.floor(renderViewport.width * dpr);
      canvas.height = Math.floor(renderViewport.height * dpr);
      canvas.style.width = `${Math.floor(renderViewport.width)}px`;
      canvas.style.height = `${Math.floor(renderViewport.height)}px`;
      canvas.style.backgroundColor = "#ffffff";
      canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasContext.fillStyle = "#ffffff";
      canvasContext.fillRect(0, 0, renderViewport.width, renderViewport.height);

      textLayer.className = "pdf-text-layer textLayer";
      textLayer.dataset.page = String(pageNumber);
      textLayer.style.width = `${Math.floor(renderViewport.width)}px`;
      textLayer.style.height = `${Math.floor(renderViewport.height)}px`;

      pageWrap.append(canvas, textLayer);

      const textContent = await page.getTextContent();
      this.textCache.set(pageNumber, collapseWhitespace(textContent.items.map((item) => item.str).join(" ")));

      await page.render({ canvasContext, viewport: renderViewport }).promise;
      await this.renderTextLayer(textLayer, textContent, renderViewport);
      return pageWrap;
    }

    async renderTextLayer(container, textContent, viewport) {
      if (window.pdfjsLib && typeof window.pdfjsLib.renderTextLayer === "function") {
        const task = window.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container,
          viewport,
          textDivs: [],
          enhanceTextSelection: true,
        });
        if (task && task.promise) await task.promise;
      }
    }

    next(location) {
      return { unit: "page", page: clamp((location.page || 1) + 1, 1, this.pageCount) };
    }

    prev(location) {
      return { unit: "page", page: clamp((location.page || 1) - 1, 1, this.pageCount) };
    }

    isAtStart(location) {
      return (location.page || 1) <= 1;
    }

    isAtEnd(location) {
      return (location.page || 1) >= this.pageCount;
    }

    getPercentage(location) {
      if (!this.pageCount) return 0;
      return clamp((location.page || 1) / this.pageCount, 0, 1);
    }

    getLocationLabel(location) {
      return `第 ${clamp(location.page || 1, 1, this.pageCount)} / ${this.pageCount} 页`;
    }

    async getPageText(pageNumber) {
      if (this.textCache.has(pageNumber)) return this.textCache.get(pageNumber);
      const page = await this.pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = collapseWhitespace(content.items.map((item) => item.str).join(" "));
      this.textCache.set(pageNumber, text);
      return text;
    }

    async getIndexUnits(onProgress) {
      const units = [];
      for (let page = 1; page <= this.pageCount; page += 1) {
        units.push({
          id: String(page),
          title: `第 ${page} 页`,
          text: await this.getPageText(page),
          location: { unit: "page", page },
        });
        if (onProgress) onProgress(page, this.pageCount);
      }
      return units;
    }

    async search(query) {
      return searchTextUnits(query, await this.getIndexUnits());
    }
  }

  async function init() {
    applyTheme(localStorage.getItem(THEME_KEY) || "p5");
    applyLayout(state.layoutMode);
    applyZoom(state.zoom, false);
    applyRailState();
    buildColorSwatches();
    bindEvents();

    try {
      state.db = await BookStore.open();
      await refreshLibrary();
      if (!state.db) {
        showToast("当前浏览器不支持 IndexedDB，书库不会跨刷新保存。");
      }
    } catch (error) {
      console.error(error);
      showToast("书库初始化失败，仍可临时打开文件。");
    }
  }

  function bindEvents() {
    els.bookInput.addEventListener("change", handleFileImport);
    els.themeSelect.addEventListener("change", () => applyTheme(els.themeSelect.value));
    els.layoutSelect.addEventListener("change", async () => {
      applyLayout(els.layoutSelect.value);
      if (state.adapter) await renderCurrent();
    });
    els.toggleLibraryBtn.addEventListener("click", () => toggleRail("left"));
    els.toggleToolsBtn.addEventListener("click", () => toggleRail("right"));
    els.focusModeBtn.addEventListener("click", () => toggleFocusMode());
    els.zoomOutBtn.addEventListener("click", () => changeZoom(-0.1));
    els.zoomInBtn.addEventListener("click", () => changeZoom(0.1));
    els.zoomResetBtn.addEventListener("click", () => setZoom(1));
    els.prevBtn.addEventListener("click", () => moveRelative("prev"));
    els.nextBtn.addEventListener("click", () => moveRelative("next"));
    els.searchForm.addEventListener("submit", handleSearch);
    els.rebuildIndexBtn.addEventListener("click", () => rebuildSearchIndex(true));
    els.readerViewport.addEventListener("scroll", handleViewportScroll, { passive: true });
    els.readerViewport.addEventListener("mouseup", handleReaderSelection);
    els.readerViewport.addEventListener("keyup", handleReaderSelection);
    els.annotationSaveHighlight.addEventListener("click", () => savePendingAnnotation(false));
    els.annotationSaveNote.addEventListener("click", () => savePendingAnnotation(true));
    els.annotationCancel.addEventListener("click", hideAnnotationComposer);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleKeys);
    document.addEventListener("mousedown", (event) => {
      if (!els.annotationComposer.contains(event.target) && !els.readerViewport.contains(event.target)) {
        hideAnnotationComposer();
      }
    });
  }

  async function handleFileImport(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;

    const type = inferType(file.name, file.type);
    if (!SUPPORTED_TYPES.has(type)) {
      showToast("只支持 EPUB、TXT、PDF。");
      return;
    }

    const record = {
      id: fileId(file),
      name: file.name,
      type,
      size: file.size,
      lastModified: file.lastModified,
      addedAt: Date.now(),
      title: stripExtension(file.name),
      blob: file,
    };

    try {
      if (state.db) {
        await state.db.put(record);
        await refreshLibrary();
      } else {
        state.library = [record, ...state.library.filter((book) => book.id !== record.id)];
        renderLibrary();
      }
      await openBook(record);
    } catch (error) {
      console.error(error);
      showToast(error.message || "导入失败。");
    }
  }

  async function refreshLibrary() {
    state.library = state.db ? await state.db.list() : [];
    renderLibrary();
  }

  function renderLibrary() {
    els.libraryCount.textContent = String(state.library.length);
    if (!state.library.length) {
      els.libraryList.innerHTML = `<div class="empty-list">还没有导入的书。</div>`;
      return;
    }

    els.libraryList.innerHTML = "";
    for (const record of state.library) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "library-item";
      if (state.activeBookRecord && state.activeBookRecord.id === record.id) button.classList.add("is-active");
      button.innerHTML = `
        <strong>${escapeHtml(record.title || stripExtension(record.name))}</strong>
        <span>${record.type.toUpperCase()} · ${formatBytes(record.size)} · ${formatProgress(record.id)}</span>
      `;
      button.addEventListener("click", async () => {
        const fresh = state.db ? await state.db.get(record.id) : record;
        if (fresh) await openBook(fresh);
      });
      els.libraryList.append(button);
    }
  }

  async function openBook(record) {
    const token = ++state.renderToken;
    setBusy(`正在打开 ${record.name}...`);
    state.indexReady = false;
    state.indexBookId = null;

    try {
      const adapter = createAdapter(record);
      const metadata = await adapter.load();
      if (token !== state.renderToken) return;

      record.title = metadata.title || record.title || stripExtension(record.name);
      if (state.db) {
        await state.db.put(record);
        state.library = await state.db.list();
      } else {
        state.library = [record, ...state.library.filter((book) => book.id !== record.id)];
      }

      state.activeBookRecord = record;
      state.adapter = adapter;
      state.toc = adapter.getToc();
      state.annotations = loadAnnotations(record.id);
      state.location = sanitizeSavedLocation(loadProgress(record.id)?.location, adapter) || adapter.getInitialLocation();

      els.bookTitle.textContent = record.title;
      els.bookFormat.textContent = `${record.type.toUpperCase()} · ${metadata.count || 0} 单元`;
      els.searchInput.value = "";
      renderToc();
      renderLibrary();
      renderSearchResults([]);
      renderAnnotations();
      updateLayoutControls();
      await renderCurrent();
      rebuildSearchIndex(false);
      showToast("已打开。");
    } catch (error) {
      console.error(error);
      showToast(error.message || "打开失败。");
      resetReader();
    } finally {
      clearBusy();
    }
  }

  function createAdapter(record) {
    if (record.type === "epub") return new EpubAdapter(record);
    if (record.type === "txt") return new TxtAdapter(record);
    if (record.type === "pdf") return new PdfAdapter(record);
    throw new Error("不支持的格式。");
  }

  async function renderCurrent() {
    if (!state.adapter || !state.location) return;
    const token = ++state.renderToken;
    setBusy("正在渲染...");
    hideAnnotationComposer();

    try {
      prepareViewportLayout();
      await state.adapter.render(state.location, els.readerViewport, {
        query: els.searchInput.value.trim(),
        layoutMode: state.layoutMode,
        zoom: state.zoom,
      });
      if (token !== state.renderToken) return;

      setupPagedContent();
      decorateCurrentContent();
      restoreReaderPosition();
      replayPendingPageTurn();
      updateProgressUi();
      persistProgress();
      updateControls();
      syncActiveToc();
    } catch (error) {
      console.error(error);
      showToast(error.message || "渲染失败。");
    } finally {
      clearBusy();
    }
  }

  function prepareViewportLayout() {
    els.readerViewport.classList.toggle("is-paged", isPagedMode());
    els.readerViewport.classList.toggle("is-column-paged", isColumnPagedMode());
    els.readerViewport.classList.toggle("is-pdf-paged", isPdfPagedMode());
    els.readerViewport.scrollTop = 0;
    els.readerViewport.scrollLeft = 0;
  }

  function setupPagedContent() {
    const article = els.readerViewport.querySelector(".book-content");
    if (!article) return;
    article.classList.toggle("is-paginated", isColumnPagedMode());
    if (!isColumnPagedMode()) {
      article.style.removeProperty("--reader-page-width");
      article.style.removeProperty("--reader-page-height");
      article.style.removeProperty("--reader-page-gap");
      article.style.removeProperty("--reader-spread-width");
      article.style.removeProperty("transform");
      return;
    }

    const metrics = calculateColumnPagedMetrics();
    state.pagedMetrics = metrics;
    const frame = ensureEpubPageFrame(article);
    const pageWidth = metrics.pageWidth;
    const pageHeight = metrics.pageHeight;
    article.style.setProperty("--reader-page-width", `${pageWidth}px`);
    article.style.setProperty("--reader-page-height", `${pageHeight}px`);
    article.style.setProperty("--reader-page-gap", `${metrics.pageGap}px`);
    article.style.setProperty("--reader-spread-width", `${metrics.spreadWidth}px`);
    article.style.setProperty("--reader-pages-per-spread", String(metrics.pagesPerSpread));
    frame.style.setProperty("--reader-page-width", `${pageWidth}px`);
    frame.style.setProperty("--reader-page-height", `${pageHeight}px`);
    frame.style.setProperty("--reader-page-gap", `${metrics.pageGap}px`);
    frame.style.setProperty("--reader-spread-width", `${metrics.spreadWidth}px`);
    frame.classList.toggle("is-double-page", metrics.pagesPerSpread === 2);
    syncEpubPagerExtent(article);
    requestAnimationFrame(() => syncEpubPagerExtent(article));
  }

  function ensureEpubPageFrame(article) {
    if (article.parentElement?.classList.contains("epub-page-frame")) return article.parentElement;
    const frame = document.createElement("div");
    frame.className = "epub-page-frame";
    article.parentNode.insertBefore(frame, article);
    frame.append(article);
    return frame;
  }

  function syncEpubPagerExtent(article) {
    if (!isColumnPagedMode() || !article) return;
    const totalWidth = Math.max(article.scrollWidth, article.offsetWidth, state.pagedMetrics.spreadWidth || 0);
    const step = Math.max(1, state.pagedMetrics.spreadStep);
    const rawMaxOffset = Math.max(0, totalWidth - (state.pagedMetrics.spreadWidth || 0));
    const maxOffset = rawMaxOffset > 0 ? Math.ceil(rawMaxOffset / step) * step : 0;
    state.pagedMetrics = {
      ...state.pagedMetrics,
      totalWidth,
      maxOffset,
      maxSpreadIndex: maxOffset > 0 ? Math.ceil(maxOffset / step) : 0,
    };
    applyEpubPageOffset(false);
  }

  function calculateColumnPagedMetrics() {
    const viewportWidth = Math.max(360, els.readerViewport.clientWidth);
    const viewportHeight = Math.max(420, els.readerViewport.clientHeight);
    const pagesPerSpread = viewportWidth >= 760 ? 2 : 1;
    const sidePadding = pagesPerSpread === 2 ? clamp(Math.round(viewportWidth * 0.04), 28, 56) : 22;
    const pageGap = pagesPerSpread === 2 ? clamp(Math.round(viewportWidth * 0.025), 20, 34) : 0;
    const availableWidth = Math.max(300, viewportWidth - sidePadding * 2);
    const pageWidth = Math.floor((availableWidth - pageGap * (pagesPerSpread - 1)) / pagesPerSpread);
    const pageHeight = Math.max(360, viewportHeight - 56);
    const spreadWidth = pageWidth * pagesPerSpread + pageGap * (pagesPerSpread - 1);
    const spreadStep = pagesPerSpread * (pageWidth + pageGap);
    return { pagesPerSpread, pageWidth, pageHeight, pageGap, spreadWidth, spreadStep };
  }

  function applyEpubPageOffset(animated) {
    const article = els.readerViewport.querySelector(".book-content.is-paginated");
    if (!article) return;
    const maxOffset = state.pagedMetrics.maxOffset || 0;
    const offset = maxOffset > 0 ? clamp((state.location?.ratio || 0) * maxOffset, 0, maxOffset) : 0;
    article.classList.toggle("is-turning", Boolean(animated));
    article.style.transform = `translateX(${-Math.round(offset)}px)`;
    if (animated) {
      window.setTimeout(() => article.classList.remove("is-turning"), 260);
    }
  }

  function decorateCurrentContent() {
    const roots = getDecoratableRoots();
    for (const root of roots) {
      applyAnnotations(root);
      highlightTerm(root, els.searchInput.value.trim());
    }
  }

  function getDecoratableRoots() {
    const pdfLayers = Array.from(els.readerViewport.querySelectorAll(".pdf-text-layer"));
    if (pdfLayers.length) return pdfLayers;
    const article = els.readerViewport.querySelector(".book-content");
    return article ? [article] : [];
  }

  function restoreReaderPosition() {
    requestAnimationFrame(() => {
      if (!state.location) return;
      if (state.location.anchor) {
        const namedAnchor = Array.from(document.getElementsByName(state.location.anchor)).find((node) =>
          els.readerViewport.contains(node),
        );
        const anchor = document.getElementById(state.location.anchor) || namedAnchor;
        if (anchor) anchor.scrollIntoView({ block: "start", inline: "start" });
      }

      const ratio = clamp(state.location.ratio || 0, 0, 1);
      if (isColumnPagedMode()) {
        applyEpubPageOffset(false);
      } else if (state.location.unit === "chapter") {
        const max = els.readerViewport.scrollHeight - els.readerViewport.clientHeight;
        els.readerViewport.scrollTop = max > 0 ? max * ratio : 0;
      }
    });
  }

  function renderToc() {
    els.tocCount.textContent = String(state.toc.length);
    els.tocList.innerHTML = "";

    if (!state.toc.length) {
      els.tocList.innerHTML = `<div class="empty-list">没有可用目录。</div>`;
      return;
    }

    state.toc.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toc-item";
      button.dataset.tocIndex = String(index);
      button.style.setProperty("--toc-indent", `${Math.min(item.level || 0, 4) * 14}px`);
      button.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${locationSummary(item.location)}</span>`;
      button.addEventListener("click", async () => navigateTo(item.location));
      els.tocList.append(button);
    });

    syncActiveToc();
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (!state.adapter) {
      showToast("请先打开一本书。");
      return;
    }

    const query = els.searchInput.value.trim();
    if (!query) {
      renderSearchResults([]);
      await renderCurrent();
      return;
    }

    els.searchStatus.textContent = state.indexReady ? "正在用全文索引搜索..." : "索引未就绪，正在直接搜索...";
    els.searchCount.textContent = "0";
    try {
      const results =
        state.searchClient && state.indexReady && state.indexBookId === state.activeBookRecord.id
          ? await state.searchClient.search(state.activeBookRecord.id, query)
          : await state.adapter.search(query);
      renderSearchResults(results);
      await renderCurrent();
    } catch (error) {
      console.error(error);
      showToast(error.message || "搜索失败。");
      els.searchStatus.textContent = "搜索失败。";
    }
  }

  function renderSearchResults(results) {
    els.searchCount.textContent = String(results.length);
    els.searchResults.innerHTML = "";

    if (!state.adapter) {
      els.searchStatus.textContent = "打开书籍后可搜索。";
      return;
    }

    if (!els.searchInput.value.trim()) {
      els.searchStatus.textContent = state.indexReady ? "全文索引已就绪。" : "索引建立中，可直接搜索。";
      return;
    }

    if (!results.length) {
      els.searchStatus.textContent = "没有匹配结果。";
      return;
    }

    els.searchStatus.textContent = `找到 ${results.length} 个结果。`;
    for (const result of results.slice(0, 120)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.innerHTML = `
        <strong>${escapeHtml(result.title)}</strong>
        <span>${escapeHtml(result.snippet)}</span>
      `;
      button.addEventListener("click", async () => navigateTo(result.location));
      els.searchResults.append(button);
    }
  }

  async function rebuildSearchIndex(manual) {
    if (!state.adapter || !state.activeBookRecord) return;
    const token = ++state.indexToken;
    state.indexReady = false;
    state.indexBookId = null;
    els.searchStatus.textContent = "正在建立全文索引...";
    els.rebuildIndexBtn.disabled = true;

    try {
      const client = ensureSearchClient();
      if (!client) {
        els.searchStatus.textContent = "当前环境不能启动 Worker，搜索会回退到直接扫描。";
        return;
      }

      const units = await state.adapter.getIndexUnits((done, total) => {
        if (token === state.indexToken) {
          els.searchStatus.textContent = `正在抽取文本 ${done} / ${total}...`;
        }
      });
      if (token !== state.indexToken) return;

      const result = await client.build(state.activeBookRecord.id, units);
      if (token !== state.indexToken) return;
      state.indexReady = true;
      state.indexBookId = state.activeBookRecord.id;
      els.searchStatus.textContent = `全文索引已就绪：${result.unitCount} 个单元，${result.termCount} 个词项。`;
      if (manual) showToast("全文索引已重建。");
    } catch (error) {
      console.error(error);
      els.searchStatus.textContent = "全文索引不可用，搜索会回退到直接扫描。";
      if (manual) showToast(error.message || "索引建立失败。");
    } finally {
      els.rebuildIndexBtn.disabled = false;
    }
  }

  function ensureSearchClient() {
    if (state.searchClient) return state.searchClient;
    try {
      state.searchClient = new SearchIndexClient();
      return state.searchClient;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  async function navigateTo(location) {
    if (!location) return;
    state.location = { ...location };
    await renderCurrent();
  }

  async function moveRelative(direction) {
    if (!state.adapter || !state.location) return;
    if (await turnPdfSpread(direction)) return;
    if (turnPaged(direction)) return;
    queuePageTurn(direction);
    const nextLocation = direction === "next" ? state.adapter.next(state.location) : state.adapter.prev(state.location);
    await navigateTo(nextLocation);
  }

  async function turnPdfSpread(direction) {
    if (!isPdfPagedMode() || !state.location || state.location.unit !== "page") return false;
    const step = 1;
    const current = state.location.page || 1;
    if (direction === "next" && current + step > state.adapter.pageCount) return true;
    if (direction === "prev" && current <= 1) return true;
    const target =
      direction === "next"
        ? Math.min(state.adapter.pageCount, current + step)
        : Math.max(1, current - step);
    if (target === current) return false;
    queuePageTurn(direction);
    await navigateTo({ unit: "page", page: target });
    return true;
  }

  function turnPaged(direction) {
    if (!isColumnPagedMode() || !state.location || state.location.unit !== "chapter") return false;

    const max = state.pagedMetrics.maxOffset || 0;
    if (max <= 0) return false;

    const page = Math.max(240, state.pagedMetrics.spreadStep || els.readerViewport.clientWidth - 24);
    const current = clamp((state.location.ratio || 0) * max, 0, max);
    const target = direction === "next" ? Math.min(max, current + page) : Math.max(0, current - page);
    const canMove = direction === "next" ? current < max - 8 : current > 8;
    if (!canMove) return false;

    playPageTurn(direction);
    state.turnDirection = "";
    state.location = {
      ...state.location,
      ratio: max > 0 ? clamp(target / max, 0, 1) : 0,
      anchor: "",
    };
    applyEpubPageOffset(true);
    updateProgressUi();
    persistProgress();
    updateControls();
    return true;
  }

  function queuePageTurn(direction) {
    state.turnDirection = direction;
  }

  function playPageTurn(direction) {
    applyPageTurnClass(direction);
  }

  function replayPendingPageTurn() {
    if (!state.turnDirection) return;
    if (!isPagedMode()) {
      state.turnDirection = "";
      return;
    }
    applyPageTurnClass(state.turnDirection);
    state.turnDirection = "";
  }

  function applyPageTurnClass(direction) {
    window.clearTimeout(state.turnTimer);
    els.readerViewport.classList.remove("is-flipping-next", "is-flipping-prev");
    void els.readerViewport.offsetWidth;
    els.readerViewport.classList.add(direction === "next" ? "is-flipping-next" : "is-flipping-prev");
    state.turnTimer = window.setTimeout(() => {
      els.readerViewport.classList.remove("is-flipping-next", "is-flipping-prev");
    }, 280);
  }

  function handleViewportScroll() {
    if (!state.adapter || !state.location || state.location.unit !== "chapter") return;
    if (state.scrollFrame) return;
    state.scrollFrame = requestAnimationFrame(() => {
      state.scrollFrame = 0;
      state.location = {
        ...state.location,
        ratio: readReaderRatio(),
        anchor: "",
      };
      updateProgressUi();
      persistProgress();
      updateControls();
    });
  }

  function handleResize() {
    if (!state.adapter || !state.location) return;
    if (state.resizeFrame) cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = requestAnimationFrame(() => renderCurrent());
  }

  function handleKeys(event) {
    if (!state.adapter) return;
    const target = event.target;
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
    if (event.ctrlKey && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      changeZoom(0.1);
      return;
    }
    if (event.ctrlKey && event.key === "-") {
      event.preventDefault();
      changeZoom(-0.1);
      return;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFocusMode();
      return;
    }
    if (event.key === "Escape") hideAnnotationComposer();
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      moveRelative("next");
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      moveRelative("prev");
    }
  }

  function handleReaderSelection() {
    if (!state.adapter || !state.activeBookRecord) return;
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      if (!els.readerViewport.contains(range.commonAncestorContainer)) return;
      const quote = collapseWhitespace(selection.toString()).slice(0, 1200);
      if (!quote || quote.length < 2) return;

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const pageElement = range.commonAncestorContainer.parentElement?.closest?.(".pdf-page[data-page]");
      const page = Number(pageElement?.dataset.page);
      const location = Number.isFinite(page) && page > 0 ? { unit: "page", page } : null;
      showAnnotationComposer({ quote, rect, location });
    }, 0);
  }

  function showAnnotationComposer({ quote, rect, location: explicitLocation }) {
    const location = explicitLocation ? { ...explicitLocation } : { ...state.location };
    if (location.unit === "chapter") location.ratio = readReaderRatio();

    state.pendingSelection = {
      bookId: state.activeBookRecord.id,
      quote,
      location,
    };

    els.annotationQuote.textContent = quote;
    els.annotationNote.value = "";
    els.annotationComposer.hidden = false;
    els.annotationComposer.classList.add("is-visible");

    const width = 320;
    const left = clamp(rect.left, 12, window.innerWidth - width - 12);
    const top = clamp(rect.bottom + 10, 12, window.innerHeight - 230);
    els.annotationComposer.style.left = `${left}px`;
    els.annotationComposer.style.top = `${top}px`;
    els.annotationNote.focus({ preventScroll: true });
  }

  function hideAnnotationComposer() {
    state.pendingSelection = null;
    els.annotationComposer.hidden = true;
    els.annotationComposer.classList.remove("is-visible");
    window.getSelection()?.removeAllRanges();
  }

  function savePendingAnnotation(withNote) {
    if (!state.pendingSelection || !state.activeBookRecord) return;
    const note = els.annotationNote.value.trim();
    if (withNote && !note) {
      showToast("写一点笔记内容再保存。");
      return;
    }

    const annotation = {
      id: createId("ann"),
      bookId: state.activeBookRecord.id,
      quote: state.pendingSelection.quote,
      note,
      color: state.selectedAnnotationColor,
      location: state.pendingSelection.location,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.annotations.unshift(annotation);
    saveAnnotations(state.activeBookRecord.id, state.annotations);
    hideAnnotationComposer();
    renderAnnotations();
    decorateCurrentContent();
    showToast(withNote ? "笔记已保存。" : "高亮已保存。");
  }

  function renderAnnotations() {
    els.annotationCount.textContent = String(state.annotations.length);
    els.annotationList.innerHTML = "";

    if (!state.activeBookRecord) {
      els.annotationList.innerHTML = `<div class="empty-list">打开书籍后可添加高亮和笔记。</div>`;
      return;
    }

    if (!state.annotations.length) {
      els.annotationList.innerHTML = `<div class="empty-list">选中文字即可添加高亮或笔记。</div>`;
      return;
    }

    for (const annotation of state.annotations) {
      const item = document.createElement("article");
      item.className = "annotation-item";
      item.style.setProperty("--annotation-color", annotation.color || DEFAULT_ANNOTATION_COLOR);
      item.innerHTML = `
        <button class="annotation-jump" type="button">
          <strong>${escapeHtml(annotation.quote)}</strong>
          ${annotation.note ? `<span>${escapeHtml(annotation.note)}</span>` : ""}
          <small>${escapeHtml(locationSummary(annotation.location))} · ${formatDate(annotation.createdAt)}</small>
        </button>
        <button class="annotation-delete" type="button" aria-label="删除笔记">×</button>
      `;
      item.querySelector(".annotation-jump").addEventListener("click", () => navigateTo(annotation.location));
      item.querySelector(".annotation-delete").addEventListener("click", () => deleteAnnotation(annotation.id));
      els.annotationList.append(item);
    }
  }

  function deleteAnnotation(id) {
    state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
    if (state.activeBookRecord) saveAnnotations(state.activeBookRecord.id, state.annotations);
    renderAnnotations();
    renderCurrent();
  }

  function applyAnnotations(root) {
    if (!state.location || !state.annotations.length) return;
    const page = Number(root.dataset.page);
    const rootLocation = Number.isFinite(page) && page > 0 ? { unit: "page", page } : state.location;
    const current = state.annotations.filter((annotation) => sameAnnotationLocation(annotation.location, rootLocation));
    for (const annotation of current) {
      const marked =
        markText(root, annotation.quote, (text) => buildAnnotationMark(annotation, text)) ||
        markText(root, annotation.quote.slice(0, 80), (text) => buildAnnotationMark(annotation, text));
      if (!marked) {
        const firstToken = firstUsefulToken(annotation.quote);
        if (firstToken) markText(root, firstToken, (text) => buildAnnotationMark(annotation, text), 1);
      }
    }
  }

  function buildAnnotationMark(annotation, text) {
    const mark = document.createElement("mark");
    mark.className = "annotation-mark";
    mark.dataset.annotationId = annotation.id;
    mark.style.setProperty("--mark-color", annotation.color || DEFAULT_ANNOTATION_COLOR);
    mark.title = annotation.note || "高亮";
    mark.textContent = text;
    return mark;
  }

  function buildColorSwatches() {
    els.annotationColors.innerHTML = "";
    for (const color of ANNOTATION_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-swatch";
      button.style.backgroundColor = color;
      button.setAttribute("aria-label", `颜色 ${color}`);
      if (color === state.selectedAnnotationColor) button.classList.add("is-active");
      button.addEventListener("click", () => {
        state.selectedAnnotationColor = color;
        for (const item of els.annotationColors.querySelectorAll(".color-swatch")) {
          item.classList.remove("is-active");
        }
        button.classList.add("is-active");
      });
      els.annotationColors.append(button);
    }
  }

  function updateProgressUi() {
    if (!state.adapter || !state.location) {
      els.progressFill.style.width = "0%";
      els.progressLabel.textContent = "0%";
      els.locationLabel.textContent = "尚未打开书籍";
      return;
    }

    const percentage = state.adapter.getPercentage(state.location);
    const text = `${Math.round(percentage * 100)}%`;
    els.progressFill.style.width = text;
    els.progressLabel.textContent = text;
    els.locationLabel.textContent = state.adapter.getLocationLabel(state.location);
  }

  function updateControls() {
    if (!state.adapter || !state.location) {
      els.prevBtn.disabled = true;
      els.nextBtn.disabled = true;
      return;
    }
    if (isPdfPagedMode()) {
      els.prevBtn.disabled = (state.location.page || 1) <= 1;
      els.nextBtn.disabled = (state.location.page || 1) >= state.adapter.pageCount;
      return;
    }
    const usesInternalPages = isColumnPagedMode();
    const atFirstInternalPage = !usesInternalPages || readReaderRatio() <= 0.01;
    const atLastInternalPage =
      !usesInternalPages || readReaderRatio() >= 0.99 || els.readerViewport.scrollWidth <= els.readerViewport.clientWidth;
    els.prevBtn.disabled = state.adapter.isAtStart(state.location) && atFirstInternalPage;
    els.nextBtn.disabled = state.adapter.isAtEnd(state.location) && atLastInternalPage;
  }

  function updateLayoutControls() {
    const supports = Boolean(state.adapter && state.adapter.supportsPagination);
    els.layoutSelect.disabled = !supports;
    els.layoutSelect.title = supports ? "当前书籍支持分页版式" : "当前格式使用固定版式";
  }

  function syncActiveToc() {
    const buttons = Array.from(els.tocList.querySelectorAll(".toc-item"));
    for (const button of buttons) button.classList.remove("is-active");
    if (!state.location) return;

    let bestButton = null;
    let bestOrder = -1;
    state.toc.forEach((item, index) => {
      if (sameUnit(item.location, state.location)) {
        const itemOrder = locationOrder(item.location);
        const currentOrder = locationOrder(state.location);
        if (itemOrder <= currentOrder && itemOrder >= bestOrder) {
          bestOrder = itemOrder;
          bestButton = buttons[index];
        }
      }
    });

    if (bestButton) bestButton.classList.add("is-active");
  }

  function persistProgress() {
    if (!state.activeBookRecord || !state.adapter || !state.location) return;
    const percentage = state.adapter.getPercentage(state.location);
    const progress = {
      bookId: state.activeBookRecord.id,
      location: state.location,
      percentage,
      label: state.adapter.getLocationLabel(state.location),
      updatedAt: Date.now(),
    };
    localStorage.setItem(`${PROGRESS_PREFIX}${state.activeBookRecord.id}`, JSON.stringify(progress));
    scheduleLibraryRender();
  }

  function scheduleLibraryRender() {
    if (state.libraryFrame) return;
    state.libraryFrame = window.setTimeout(() => {
      state.libraryFrame = 0;
      renderLibrary();
    }, 500);
  }

  function loadProgress(id) {
    try {
      return JSON.parse(localStorage.getItem(`${PROGRESS_PREFIX}${id}`) || "null");
    } catch (_) {
      return null;
    }
  }

  function loadAnnotations(id) {
    try {
      const items = JSON.parse(localStorage.getItem(`${ANNOTATION_PREFIX}${id}`) || "[]");
      return Array.isArray(items) ? items : [];
    } catch (_) {
      return [];
    }
  }

  function saveAnnotations(id, annotations) {
    localStorage.setItem(`${ANNOTATION_PREFIX}${id}`, JSON.stringify(annotations));
  }

  function sanitizeSavedLocation(location, adapter) {
    if (!location || !adapter) return null;
    if (adapter.type === "pdf" && location.unit === "page") {
      return { unit: "page", page: clamp(location.page || 1, 1, adapter.pageCount) };
    }
    if ((adapter.type === "txt" || adapter.type === "epub") && location.unit === "chapter") {
      return {
        unit: "chapter",
        index: clamp(location.index || 0, 0, adapter.chapters.length - 1),
        ratio: clamp(location.ratio || 0, 0, 1),
        anchor: location.anchor || "",
      };
    }
    return null;
  }

  function resetReader() {
    state.activeBookRecord = null;
    state.adapter = null;
    state.location = null;
    state.toc = [];
    state.annotations = [];
    state.indexReady = false;
    state.indexBookId = null;
    els.bookTitle.textContent = "未选择书籍";
    els.bookFormat.textContent = "等待导入";
    els.readerViewport.innerHTML = `
      <div class="empty-state">
        <strong>选择一本书开始阅读</strong>
        <span>导入 EPUB、TXT 或 PDF 后会进入统一阅读页。</span>
      </div>
    `;
    renderToc();
    renderSearchResults([]);
    renderAnnotations();
    updateProgressUi();
    updateControls();
    updateLayoutControls();
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    els.themeSelect.value = theme;
    localStorage.setItem(THEME_KEY, theme);
  }

  function applyLayout(layout) {
    state.layoutMode = layout === "paged" ? "paged" : "scroll";
    els.layoutSelect.value = state.layoutMode;
    localStorage.setItem(LAYOUT_KEY, state.layoutMode);
    document.body.dataset.layout = state.layoutMode;
  }

  function changeZoom(delta) {
    setZoom(state.zoom + delta);
  }

  function setZoom(value) {
    const next = clamp(Math.round(value * 20) / 20, 0.75, 2.25);
    if (Math.abs(next - state.zoom) < 0.001) return;
    state.zoom = next;
    applyZoom(next, true);
  }

  function applyZoom(value, shouldRender) {
    state.zoom = clamp(value, 0.75, 2.25);
    document.documentElement.style.setProperty("--reader-zoom", String(state.zoom));
    els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    els.zoomOutBtn.disabled = state.zoom <= 0.75;
    els.zoomInBtn.disabled = state.zoom >= 2.25;
    localStorage.setItem(ZOOM_KEY, String(state.zoom));
    if (shouldRender && state.adapter) {
      if (state.location && state.location.unit === "chapter") {
        state.location = { ...state.location, ratio: readReaderRatio() };
      }
      renderCurrent();
    }
  }

  function toggleRail(side) {
    if (side === "left") state.rails.left = !state.rails.left;
    if (side === "right") state.rails.right = !state.rails.right;
    applyRailState();
  }

  function toggleFocusMode() {
    const collapsed = state.rails.left && state.rails.right;
    state.rails.left = !collapsed;
    state.rails.right = !collapsed;
    applyRailState();
  }

  function applyRailState() {
    document.body.classList.toggle("rail-left-collapsed", state.rails.left);
    document.body.classList.toggle("rail-right-collapsed", state.rails.right);
    els.toggleLibraryBtn.classList.toggle("is-active", state.rails.left);
    els.toggleToolsBtn.classList.toggle("is-active", state.rails.right);
    els.focusModeBtn.classList.toggle("is-active", state.rails.left && state.rails.right);
    els.toggleLibraryBtn.setAttribute("aria-pressed", String(state.rails.left));
    els.toggleToolsBtn.setAttribute("aria-pressed", String(state.rails.right));
    els.focusModeBtn.setAttribute("aria-pressed", String(state.rails.left && state.rails.right));
    localStorage.setItem(RAILS_KEY, JSON.stringify(state.rails));
    if (state.adapter) handleResize();
  }

  function loadRailState() {
    try {
      const value = JSON.parse(localStorage.getItem(RAILS_KEY) || "null");
      return {
        left: Boolean(value && value.left),
        right: Boolean(value && value.right),
      };
    } catch (_) {
      return { left: false, right: false };
    }
  }

  function isPagedMode() {
    return state.layoutMode === "paged" && state.adapter && state.adapter.supportsPagination;
  }

  function isColumnPagedMode() {
    return isPagedMode() && state.location && state.location.unit === "chapter";
  }

  function isPdfPagedMode() {
    return isPagedMode() && state.location && state.location.unit === "page";
  }

  function getPdfPagesPerSpread() {
    return isPdfPagedMode() && els.readerViewport.clientWidth >= 760 ? 2 : 1;
  }

  function setBusy(message) {
    els.readerViewport.setAttribute("aria-busy", "true");
    els.locationLabel.textContent = message;
  }

  function clearBusy() {
    els.readerViewport.removeAttribute("aria-busy");
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
  }

  function searchTextUnits(query, units) {
    const needle = query.toLocaleLowerCase();
    const results = [];
    for (const unit of units) {
      const text = unit.text || "";
      const haystack = text.toLocaleLowerCase();
      let from = 0;
      while (results.length < 200) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) break;
        results.push({
          title: unit.title,
          snippet: createSnippet(text, index, query.length),
          location: { ...unit.location },
        });
        from = index + Math.max(needle.length, 1);
      }
      if (results.length >= 200) break;
    }
    return results;
  }

  function createSnippet(text, index, length) {
    const start = Math.max(0, index - 42);
    const end = Math.min(text.length, index + length + 58);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    return `${prefix}${collapseWhitespace(text.slice(start, end))}${suffix}`;
  }

  function splitTxtChapters(text) {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    const headingRe =
      /(^|\n)(第[零〇一二三四五六七八九十百千万\d]+[章节回卷集部][^\n]{0,48}|Chapter\s+\d+[^\n]{0,64}|CHAPTER\s+\d+[^\n]{0,64})/g;
    const matches = Array.from(normalized.matchAll(headingRe));

    if (matches.length >= 2) {
      return matches.map((match, index) => {
        const start = match.index + match[1].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
        return {
          title: collapseWhitespace(match[2]),
          text: normalized.slice(start, end).trim(),
        };
      });
    }

    const chunkSize = 9000;
    const chapters = [];
    for (let start = 0; start < normalized.length; start += chunkSize) {
      chapters.push({
        title: `片段 ${chapters.length + 1}`,
        text: normalized.slice(start, start + chunkSize).trim(),
      });
    }
    return chapters.length ? chapters : [{ title: "正文", text: "" }];
  }

  function decodeText(buffer) {
    const encodings = ["utf-8", "gb18030", "big5"];
    for (const encoding of encodings) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(buffer);
      } catch (_) {
        continue;
      }
    }
    return new TextDecoder("utf-8").decode(buffer);
  }

  function highlightTerm(root, term) {
    const query = term && term.trim();
    if (!query) return;
    markText(root, query, (text) => {
      const mark = document.createElement("mark");
      mark.className = "reader-hit";
      mark.textContent = text;
      return mark;
    });
  }

  function markText(root, needle, buildMark, limit = Infinity) {
    const query = collapseWhitespace(needle);
    if (!query) return 0;
    const lowerQuery = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || /^(script|style|mark)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLocaleLowerCase().includes(lowerQuery)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    let marked = 0;
    for (const node of nodes) {
      if (marked >= limit) break;
      const value = node.nodeValue;
      const lower = value.toLocaleLowerCase();
      let from = 0;
      let changed = false;
      const fragment = document.createDocumentFragment();

      while (marked < limit) {
        const index = lower.indexOf(lowerQuery, from);
        if (index < 0) break;
        fragment.append(document.createTextNode(value.slice(from, index)));
        fragment.append(buildMark(value.slice(index, index + query.length)));
        from = index + query.length;
        changed = true;
        marked += 1;
      }

      if (changed) {
        fragment.append(document.createTextNode(value.slice(from)));
        node.parentNode.replaceChild(fragment, node);
      }
    }

    return marked;
  }

  function bindEpubLinks(article, baseDir, onNavigate) {
    for (const anchor of Array.from(article.querySelectorAll("a[href]"))) {
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:|tel:|#)/i.test(href)) continue;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        onNavigate(normalizePath(baseDir, href));
      });
    }
  }

  function sanitizeHtmlDocument(doc) {
    for (const node of Array.from(doc.querySelectorAll("script, iframe, object, embed"))) {
      node.remove();
    }
    for (const node of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    }
  }

  function scopeCss(css, scope) {
    const cleaned = css.replace(/@charset[^;]+;/gi, "");
    let result = "";
    let index = 0;

    while (index < cleaned.length) {
      const brace = cleaned.indexOf("{", index);
      if (brace < 0) {
        result += cleaned.slice(index);
        break;
      }

      const selector = cleaned.slice(index, brace).trim();
      const close = findMatchingBrace(cleaned, brace);
      if (close < 0) {
        result += cleaned.slice(index);
        break;
      }

      const body = cleaned.slice(brace + 1, close);
      if (selector.startsWith("@media") || selector.startsWith("@supports")) {
        result += `${selector}{${scopeCss(body, scope)}}`;
      } else if (selector.startsWith("@")) {
        result += `${selector}{${body}}`;
      } else {
        const scopedSelector = selector
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            if (/^(html|body|:root)$/i.test(part)) return scope;
            if (part.startsWith(scope)) return part;
            return `${scope} ${part}`;
          })
          .join(", ");
        result += `${scopedSelector}{${body}}`;
      }

      index = close + 1;
    }

    return result;
  }

  function findMatchingBrace(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function readReaderRatio() {
    if (isColumnPagedMode()) {
      return clamp(state.location?.ratio || 0, 0, 1);
    }
    const max = els.readerViewport.scrollHeight - els.readerViewport.clientHeight;
    return max > 0 ? clamp(els.readerViewport.scrollTop / max, 0, 1) : 0;
  }

  function sameUnit(a, b) {
    return a && b && a.unit === b.unit;
  }

  function sameAnnotationLocation(a, b) {
    if (!sameUnit(a, b)) return false;
    if (a.unit === "page") return Number(a.page) === Number(b.page);
    return Number(a.index) === Number(b.index);
  }

  function locationOrder(location) {
    if (!location) return -1;
    if (location.unit === "page") return location.page || 1;
    return location.index || 0;
  }

  function locationSummary(location) {
    if (!location) return "";
    if (location.unit === "page") return `第 ${location.page} 页`;
    return `第 ${(location.index || 0) + 1} 章`;
  }

  function formatProgress(id) {
    const progress = loadProgress(id);
    if (!progress) return "未阅读";
    return `${Math.round((progress.percentage || 0) * 100)}%`;
  }

  function inferType(name, mime) {
    const ext = name.split(".").pop().toLowerCase();
    if (SUPPORTED_TYPES.has(ext)) return ext;
    if (/epub/i.test(mime)) return "epub";
    if (/pdf/i.test(mime)) return "pdf";
    if (/text/i.test(mime)) return "txt";
    return ext;
  }

  function fileId(file) {
    return `${file.name.toLowerCase()}::${file.size}::${file.lastModified}`;
  }

  function createId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function stripExtension(name) {
    return name.replace(/\.[^.]+$/, "");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function collapseWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function firstUsefulToken(value) {
    const tokens = collapseWhitespace(value).match(/[\p{L}\p{N}]{2,}|[\u4e00-\u9fff]/gu);
    return tokens ? tokens[0] : "";
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\#.;:[\]()=>+~*^$|]/g, "\\$&");
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const error = doc.querySelector("parsererror");
    if (error) throw new Error("XML parse failed.");
    return doc;
  }

  function readFirstText(doc, localName) {
    const node = Array.from(doc.getElementsByTagName("*")).find((item) => item.localName === localName);
    return node ? collapseWhitespace(node.textContent) : "";
  }

  function dirname(path) {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
  }

  function normalizePath(base, href) {
    if (!href || /^(https?:|data:|blob:|mailto:|tel:)/i.test(href)) return href || "";
    const [pathPart, hash] = href.split("#");
    const parts = [];
    const source = pathPart.startsWith("/") ? pathPart.slice(1) : [base, pathPart].filter(Boolean).join("/");
    for (const part of source.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `${parts.join("/")}${hash ? `#${hash}` : ""}`;
  }

  function mimeFromPath(path) {
    const ext = path.split(".").pop().toLowerCase();
    const mimes = {
      css: "text/css",
      gif: "image/gif",
      html: "text/html",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      js: "text/javascript",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      ncx: "application/x-dtbncx+xml",
      otf: "font/otf",
      png: "image/png",
      svg: "image/svg+xml",
      ttf: "font/ttf",
      webp: "image/webp",
      woff: "font/woff",
      woff2: "font/woff2",
      xhtml: "application/xhtml+xml",
      xml: "application/xml",
    };
    return mimes[ext] || "application/octet-stream";
  }

  init();
})();
