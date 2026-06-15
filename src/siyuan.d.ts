declare module "siyuan" {
  export type SettingItem = {
    title: string;
    description?: string;
    createActionElement: () => HTMLElement;
  };

  export class Setting {
    constructor(options?: {
      confirmCallback?: () => void;
      destroyCallback?: () => void;
    });

    addItem(item: SettingItem): void;
    open(title: string): void;
  }

  export class Plugin {
    displayName: string;
    onload?(): void;
    onunload?(): void;
    loadData<T = unknown>(path: string): Promise<T | null>;
    saveData(path: string, data: unknown): Promise<void>;
  }

  export function showMessage(message: string, timeout?: number, type?: "info" | "error"): void;
}
