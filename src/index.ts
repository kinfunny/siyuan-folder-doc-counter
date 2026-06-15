import { Plugin, Setting } from "siyuan";
import "./index.scss";

const BADGE_CLASS = "fdc-count-badge";
const REFRESH_DELAY = 50;
const INVALIDATE_REFRESH_DELAYS = [0, 120, 350, 800, 1600, 3000];
const SETTINGS_FILE = "settings.json";
const DEFAULT_SETTINGS = {
  showBackground: false,
};
const DOC_TREE_REFRESH_ACTIONS = new Set([
  "insert",
  "delete",
  "remove",
  "move",
  "rename",
  "update",
]);

type DocRow = {
  box: string;
  path: string;
};

type CountRow = {
  count: number;
};

type FiletreeDoc = {
  id?: string;
  path?: string;
  name?: string;
  subFileCount?: number;
};

type ListDocsByPathData = {
  files?: FiletreeDoc[];
};

type ApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type Settings = typeof DEFAULT_SETTINGS;

type SiyuanNotebook = {
  id: string;
  name: string;
  closed?: boolean;
};

type SiyuanWindow = Window & {
  siyuan?: {
    notebooks?: SiyuanNotebook[];
  };
};

type WsOperation = {
  action?: string;
  id?: string;
  parentID?: string;
  box?: string;
  path?: string;
  data?: unknown;
};

type WsMessage = {
  cmd?: string;
  data?: Array<{
    doOperations?: WsOperation[];
    undoOperations?: WsOperation[];
  }>;
};

export default class FolderDocCounterPlugin extends Plugin {
  private observer?: MutationObserver;
  private refreshTimer?: number;
  private invalidateTimers: number[] = [];
  private countCache = new Map<string, number>();
  private filetreeCache = new Map<string, FiletreeDoc[]>();
  private filetreePending = new Map<string, Promise<FiletreeDoc[]>>();
  private cacheVersion = 0;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private setting?: Setting;
  private lastTreeSignature = "";
  private refreshVersion = 0;
  private handleWsMain = (event: { detail?: unknown }) => {
    if (this.shouldRefreshForWsMessage(event.detail as WsMessage | undefined)) {
      this.invalidateAndRefresh();
    }
  };

  async onload() {
    await this.loadSettings();
    this.initSetting();
    this.eventBus.on("ws-main", this.handleWsMain);

    this.observer = new MutationObserver(() => this.scheduleRefreshFromDomChange());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.scheduleRefresh();
  }

  onunload() {
    this.observer?.disconnect();
    this.eventBus.off("ws-main", this.handleWsMain);
    window.clearTimeout(this.refreshTimer);
    this.invalidateTimers.forEach((timer) => window.clearTimeout(timer));
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    this.clearCaches();
  }

  async openSetting() {
    this.setting?.open(this.displayName || "Folder Doc Counter");
  }

  private async loadSettings() {
    const saved = await this.loadData<Partial<Settings>>(SETTINGS_FILE);
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  private initSetting() {
    const setting = new Setting({
      confirmCallback: async () => {
        await this.saveData(SETTINGS_FILE, this.settings);
        this.clearCaches();
        this.scheduleRefresh();
      },
      destroyCallback: () => {
        void this.saveData(SETTINGS_FILE, this.settings);
      },
    });

    let backgroundSwitch: HTMLInputElement;
    setting.addItem({
      title: "显示背景圈",
      description: "关闭后只显示纯数字，不显示圆角背景。",
      createActionElement: () => {
        backgroundSwitch = document.createElement("input");
        backgroundSwitch.type = "checkbox";
        backgroundSwitch.className = "b3-switch fn__flex-center";
        backgroundSwitch.checked = this.settings.showBackground;
        backgroundSwitch.addEventListener("change", () => {
          this.settings.showBackground = backgroundSwitch.checked;
          this.applyBadgeMode();
        });
        return backgroundSwitch;
      },
    });

    this.setting = setting;
  }

  private scheduleRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshVisibleTree();
    }, REFRESH_DELAY);
  }

  private scheduleRefreshFromDomChange() {
    const signature = this.getTreeSignature();
    if (signature !== this.lastTreeSignature) {
      this.invalidateAndRefresh();
      return;
    }
    this.scheduleRefresh();
  }

  private invalidateAndRefresh() {
    this.lastTreeSignature = this.getTreeSignature();
    this.invalidateTimers.forEach((timer) => window.clearTimeout(timer));
    this.invalidateTimers = INVALIDATE_REFRESH_DELAYS.map((delay) =>
      window.setTimeout(() => {
        this.clearCaches();
        this.scheduleRefresh();
      }, delay)
    );
  }

  private shouldRefreshForWsMessage(message?: WsMessage) {
    if (!message) return false;

    if ([
      "reloadTag",
      "removeDoc",
      "rename",
      "closeBox",
      "removeBox",
      "moveDoc",
      "createDoc",
      "reloadDoc",
      "reloaddoc",
    ].includes(message.cmd ?? "")) {
      return true;
    }

    if (message.cmd !== "transactions" || !Array.isArray(message.data)) {
      return false;
    }

    return message.data.some((transaction) => {
      const operations = [
        ...(transaction.doOperations ?? []),
        ...(transaction.undoOperations ?? []),
      ];
      return operations.some((operation) => this.isDocTreeOperation(operation));
    });
  }

  private isDocTreeOperation(operation: WsOperation) {
    if (!operation.action || !DOC_TREE_REFRESH_ACTIONS.has(operation.action)) {
      return false;
    }

    if (["insert", "delete", "remove", "move", "rename"].includes(operation.action)) {
      return true;
    }

    const payload = [
      operation.id,
      operation.parentID,
      operation.box,
      operation.path,
      typeof operation.data === "string" ? operation.data : JSON.stringify(operation.data ?? ""),
    ].join(" ");

    return /\.sy\b/.test(payload) || /"type"\s*:\s*"d"/.test(payload) || /data-type="NodeDocument"/.test(payload);
  }

  private async refreshVisibleTree() {
    const version = ++this.refreshVersion;
    const treeItems = this.findDocumentTreeItems();
    this.lastTreeSignature = treeItems.map((item) => this.getNodeId(item) ?? "").join("|");

    await Promise.all(treeItems.map(async (item) => {
      const docId = this.getNodeId(item);
      if (!docId) return;

      if (version !== this.refreshVersion) return;

      if (!this.looksLikeFolder(item)) {
        this.removeBadge(item);
        return;
      }

      const count = await this.getDescendantDocCount(docId);
      if (version !== this.refreshVersion) return;

      if (count <= 0) {
        this.removeBadge(item);
        return;
      }

      this.renderBadge(item, count);
    }));
  }

  private findDocumentTreeItems() {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          '.file-tree [data-type="navigation-file"]',
          '[data-type="navigation-root"]',
          '[data-type="navigation-book"]',
          '#sidebar [data-type="sidebar-file"] [data-node-id]',
        ].join(", ")
      )
    ).filter((item, index, items) => items.indexOf(item) === index);
  }

  private getTreeSignature() {
    return this.findDocumentTreeItems().map((item) => this.getNodeId(item) ?? "").join("|");
  }

  private getNodeId(item: HTMLElement) {
    const rawId =
      item.dataset.nodeId ||
      item.getAttribute("data-node-id") ||
      item.getAttribute("data-url") ||
      item.getAttribute("data-id");

    if (rawId) return rawId;

    const text = this.getItemText(item);
    return this.findNotebookByName(text)?.id;
  }

  private getItemText(item: HTMLElement) {
    return item.querySelector<HTMLElement>(".b3-list-item__text")?.textContent?.trim() ?? "";
  }

  private findNotebookByName(name: string) {
    if (!name) return undefined;
    return this.getNotebooks().find((notebook) => notebook.name === name);
  }

  private getNotebooks() {
    return ((window as SiyuanWindow).siyuan?.notebooks ?? []).filter((notebook) => !notebook.closed);
  }

  private isNotebookId(id: string) {
    return this.getNotebooks().some((notebook) => notebook.id === id);
  }

  private isNotebookItem(item: HTMLElement, id?: string) {
    return (
      item.getAttribute("data-type") === "navigation-root" ||
      item.getAttribute("data-type") === "navigation-book" ||
      Boolean(item.closest('[data-type="sidebar-file"]')) && Boolean(id && this.isNotebookId(id))
    );
  }

  private looksLikeFolder(item: HTMLElement) {
    const toggle = item.querySelector<HTMLElement>(".b3-list-item__toggle");
    const id = this.getNodeId(item);
    return Boolean(toggle) || this.isNotebookItem(item, id);
  }

  private async getDescendantDocCount(docId: string) {
    const cached = this.countCache.get(docId);
    if (cached !== undefined) return cached;

    if (this.isNotebookId(docId)) {
      const cacheVersion = this.cacheVersion;
      const notebookCount = await this.countDocsByPath(docId, "/");
      this.setCountCache(docId, notebookCount, cacheVersion);
      return notebookCount;
    }

    const docs = await this.sql<DocRow>(
      `select box, path from blocks where id = '${escapeSql(docId)}' and type = 'd' limit 1`
    );
    const doc = docs[0];

    if (!doc?.box || !doc?.path) {
      this.setCountCache(docId, 0);
      return 0;
    }

    const cacheVersion = this.cacheVersion;
    const count = await this.countDocsByPath(doc.box, doc.path);
    this.setCountCache(docId, count, cacheVersion);
    return count;
  }

  private async getNotebookDocCount(box: string) {
    const rows = await this.sql<CountRow>(
      `select count(*) as count
       from blocks
       where type = 'd'
         and box = '${escapeSql(box)}'`
    );

    return Number(rows[0]?.count ?? 0);
  }

  private async countDocsByPath(notebook: string, path: string): Promise<number> {
    const files = await this.listDocsByPath(notebook, path);
    let count = 0;

    for (const file of files) {
      if (!file.path) continue;
      count += 1;

      if ((file.subFileCount ?? 0) > 0) {
        count += await this.countDocsByPath(notebook, file.path);
      }
    }

    return count;
  }

  private async listDocsByPath(notebook: string, path: string) {
    const cacheKey = `${notebook}:${path}`;
    const cached = this.filetreeCache.get(cacheKey);
    if (cached) return cached;

    const pending = this.filetreePending.get(cacheKey);
    if (pending) return pending;

    const cacheVersion = this.cacheVersion;
    const request = this.api<ListDocsByPathData>("/api/filetree/listDocsByPath", {
      notebook,
      path,
    }).then((result) => {
      const files = result?.files ?? [];
      if (cacheVersion === this.cacheVersion) {
        this.filetreeCache.set(cacheKey, files);
      }
      this.filetreePending.delete(cacheKey);
      return files;
    }).catch((error) => {
      this.filetreePending.delete(cacheKey);
      throw error;
    });

    this.filetreePending.set(cacheKey, request);
    return request;
  }

  private async api<T>(url: string, body: unknown): Promise<T | undefined> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = await response.json() as ApiResponse<T>;

    if (result.code !== 0) {
      console.warn("[folder-doc-counter] API failed:", result.msg, url, body);
      return undefined;
    }

    return result.data;
  }

  private async sql<T>(stmt: string): Promise<T[]> {
    const response = await fetch("/api/query/sql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stmt }),
    });
    const result = await response.json();

    if (result.code !== 0) {
      console.warn("[folder-doc-counter] SQL failed:", result.msg, stmt);
      return [];
    }

    return result.data ?? [];
  }

  private renderBadge(item: HTMLElement, count: number) {
    const text = item.querySelector<HTMLElement>(".b3-list-item__text");
    if (!text) return;

    let badge = item.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = BADGE_CLASS;
      text.insertAdjacentElement("afterend", badge);
    }

    badge.textContent = String(count);
    badge.dataset.count = String(count);
    badge.dataset.background = String(this.settings.showBackground);
  }

  private removeBadge(item: HTMLElement) {
    item.querySelector(`.${BADGE_CLASS}`)?.remove();
  }

  private applyBadgeMode() {
    document.querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`).forEach((badge) => {
      badge.dataset.background = String(this.settings.showBackground);
    });
  }

  private clearCaches() {
    this.cacheVersion += 1;
    this.countCache.clear();
    this.filetreeCache.clear();
    this.filetreePending.clear();
  }

  private setCountCache(docId: string, count: number, cacheVersion = this.cacheVersion) {
    if (cacheVersion === this.cacheVersion) {
      this.countCache.set(docId, count);
    }
  }
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
