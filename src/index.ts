import { Plugin, Setting } from "siyuan";
import "./index.scss";

const BADGE_CLASS = "fdc-count-badge";
const REFRESH_DELAY = 300;
const SETTINGS_FILE = "settings.json";
const DEFAULT_SETTINGS = {
  showBackground: false,
};

type DocRow = {
  box: string;
  path: string;
};

type CountRow = {
  count: number;
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

export default class FolderDocCounterPlugin extends Plugin {
  private observer?: MutationObserver;
  private refreshTimer?: number;
  private countCache = new Map<string, number>();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private setting?: Setting;

  async onload() {
    await this.loadSettings();
    this.initSetting();

    this.observer = new MutationObserver(() => this.scheduleRefresh());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.scheduleRefresh();
  }

  onunload() {
    this.observer?.disconnect();
    window.clearTimeout(this.refreshTimer);
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    this.countCache.clear();
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
        this.countCache.clear();
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

  private async refreshVisibleTree() {
    const treeItems = this.findDocumentTreeItems();

    for (const item of treeItems) {
      const docId = this.getNodeId(item);
      if (!docId) continue;

      if (!this.looksLikeFolder(item)) {
        this.removeBadge(item);
        continue;
      }

      const count = await this.getDescendantDocCount(docId);
      if (count <= 0) {
        this.removeBadge(item);
        continue;
      }

      this.renderBadge(item, count);
    }
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
      const notebookCount = await this.getNotebookDocCount(docId);
      this.countCache.set(docId, notebookCount);
      return notebookCount;
    }

    const docs = await this.sql<DocRow>(
      `select box, path from blocks where id = '${escapeSql(docId)}' and type = 'd' limit 1`
    );
    const doc = docs[0];

    if (!doc?.box || !doc?.path) {
      const notebookCount = await this.getNotebookDocCount(docId);
      this.countCache.set(docId, notebookCount);
      return notebookCount;
    }

    const childPathPrefix = doc.path.replace(/\.sy$/, "");
    const rows = await this.sql<CountRow>(
      `select count(*) as count
       from blocks
       where type = 'd'
         and box = '${escapeSql(doc.box)}'
         and path like '${escapeSql(childPathPrefix)}/%.sy'`
    );

    const count = Number(rows[0]?.count ?? 0);
    this.countCache.set(docId, count);
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
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
