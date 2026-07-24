export type WorkspaceDocumentKind = "character" | "enemy" | "map";

export type WorkspaceDocumentOrigin =
  | { kind: "default" }
  | { kind: "local" }
  | { kind: "unity"; projectPath: string; jsonPath: string; name?: string };

const SESSION_KEY = "frameAction.workspaceDocuments";

type WorkspaceDocuments = Partial<Record<WorkspaceDocumentKind, WorkspaceDocumentOrigin>>;

function readDocuments(): WorkspaceDocuments {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as WorkspaceDocuments | null;
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

function writeDocument(kind: WorkspaceDocumentKind, origin: WorkspaceDocumentOrigin): void {
  const current = readDocuments();
  current[kind] = origin;
  localStorage.setItem(SESSION_KEY, JSON.stringify(current));
}

export function readDocumentOrigin(kind: WorkspaceDocumentKind): WorkspaceDocumentOrigin {
  const origin = readDocuments()[kind];
  if (origin?.kind === "unity" && origin.projectPath && origin.jsonPath) return origin;
  if (origin?.kind === "local") return origin;
  return { kind: "default" };
}

export function rememberUnityDocument(kind: WorkspaceDocumentKind, projectPath: string, jsonPath: string, name?: string): void {
  writeDocument(kind, { kind: "unity", projectPath, jsonPath, name });
}

export function rememberLocalDocument(kind: WorkspaceDocumentKind): void {
  writeDocument(kind, { kind: "local" });
}

export function rememberDefaultDocument(kind: WorkspaceDocumentKind): void {
  writeDocument(kind, { kind: "default" });
}
