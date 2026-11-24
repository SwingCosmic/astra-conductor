import type { IconDefinition, IconName } from "./types";

export type { BuiltinIconName, IconDefinition, IconName } from "./types";

const discovered = import.meta.glob<IconDefinition>("./definitions/*.ts", {
  eager: true,
  import: "default",
});

/**
 * 图标注册表：启动时自动扫描 `./definitions/*.ts` 并按文件名注册，
 * 也可通过 `registerIcon` / `registerIcons` 手动注册扩展图标。
 */
export const iconRegistry: Record<string, IconDefinition> = {};

for (const [modulePath, definition] of Object.entries(discovered)) {
  const match = /\/([^/]+)\.ts$/.exec(modulePath);
  if (match?.[1] && definition) {
    iconRegistry[match[1]] = definition;
  }
}

export function registerIcon(name: string, definition: IconDefinition): void {
  iconRegistry[name] = definition;
}

export function registerIcons(icons: Record<string, IconDefinition>): void {
  for (const [name, definition] of Object.entries(icons)) {
    iconRegistry[name] = definition;
  }
}

export function getIcon(name: IconName): IconDefinition | undefined {
  return Object.hasOwn(iconRegistry, name) ? iconRegistry[name] : undefined;
}

export function listIconNames(): string[] {
  return Object.keys(iconRegistry).sort();
}

export function isIconName(value: string | undefined): value is IconName {
  return !!value && Object.hasOwn(iconRegistry, value);
}
