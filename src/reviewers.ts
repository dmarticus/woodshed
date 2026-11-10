export type ReviewerSuggestion = {
  handle: string;
  name?: string;
  kind: "person" | "team";
  source: "code_owner" | "github" | "repository";
};

export const reviewerHandle = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9-]{0,99})?$/;

function ownershipPattern(pattern: string): RegExp {
  const directory = pattern.endsWith("/");
  const path = pattern.replace(/\/$/, "");
  const anchored = path.includes("/");
  const segments = path.replace(/^\//, "").split("/");
  let expression = anchored ? "^" : "(?:^|/)";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**" && segments.length > 1) {
      expression += last ? ".+" : "(?:[^/]+/)*";
    } else {
      expression += segment.replace(/[.+^$${}()|\\]/g, "\\$&").replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]");
      if (!last) expression += "/";
    }
  }
  return new RegExp(expression + (directory ? "/" : "(?:/|$)"));
}

export function matchingCodeOwners(text: string, files: string[]): string[] {
  const rules: { pattern: RegExp; owners: string[] }[] = [];
  for (const line of text.split("\n")) {
    const [pattern, ...owners] = (line.split(/(?:^|\s)#/, 1)[0] ?? "").trim().split(/\s+/);
    if (!pattern || pattern.startsWith("!") || /[\[\]\\]/.test(pattern)) continue;
    if (owners.some(owner => owner.startsWith("@") ? !reviewerHandle.test(owner.slice(1)) : !/^[^@]+@[^@]+$/.test(owner))) continue;
    rules.push({ pattern: ownershipPattern(pattern), owners: owners.filter(owner => owner.startsWith("@")).map(owner => owner.slice(1)) });
  }
  return [...new Set(files.flatMap(file => rules.findLast(rule => rule.pattern.test(file))?.owners ?? []))];
}
