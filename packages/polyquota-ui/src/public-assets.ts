function splitSuffix(value: string): [string, string] {
  const queryIndex = value.search(/[?#]/);
  return queryIndex === -1 ? [value, ""] : [value.slice(0, queryIndex), value.slice(queryIndex)];
}

function normalizeRelativePath(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error("Public asset paths must be relative");
  }
  const [pathname, suffix] = splitSuffix(value.replaceAll("\\", "/"));
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error("Public asset paths cannot escape the public root");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (!segments.length) throw new Error("Public asset path cannot be empty");
  return `${segments.join("/")}${suffix}`;
}

export function publicAssetPath(
  relativePath: string,
  base: string = import.meta.env.BASE_URL,
): string {
  const normalizedBase = `${base.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  return `${normalizedBase}${normalizeRelativePath(relativePath)}`;
}
