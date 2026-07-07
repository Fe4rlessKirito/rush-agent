import type { ConversationProjectContext } from "../../core/store";

interface ProjectRecord {
  id: string;
  path: string;
}

interface FileStateLike {
  mode: string;
  root: string;
  loadFromDisk: (root: string) => Promise<void>;
}

export async function openComposerProjectRoot({
  busy,
  chooseProjectRoot,
  projects,
  createProject,
  setProjectPath,
  renameProject,
  openProject,
  setConversationProjectContext,
  loadFilesFromDisk,
  onError,
}: {
  busy: boolean;
  chooseProjectRoot: () => Promise<string | null>;
  projects: ProjectRecord[];
  createProject: (name: string) => string;
  setProjectPath: (id: string, path: string) => void;
  renameProject: (id: string, name: string) => void;
  openProject: (id: string) => void;
  setConversationProjectContext: (context: NonNullable<ConversationProjectContext>) => void;
  loadFilesFromDisk: (root: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  if (busy) return;
  try {
    const picked = await chooseProjectRoot();
    if (!picked) return;
    const cleanRoot = picked.trim().replace(/[\\/]+$/, "");
    const folderName = cleanRoot.split(/[\\/]/).pop() || "Project";
    let id = projects.find((project) => project.path.trim().replace(/[\\/]+$/, "") === cleanRoot)?.id;
    if (!id) {
      id = createProject(folderName);
      setProjectPath(id, cleanRoot);
      renameProject(id, folderName);
    }
    openProject(id);
    setConversationProjectContext({
      projectId: id,
      projectRoot: cleanRoot,
      projectName: folderName,
    });
    await loadFilesFromDisk(cleanRoot);
  } catch (err) {
    onError(`Open project root failed: ${String(err)}`);
  }
}

export async function syncConversationProjectRoot({
  isAgentMode,
  conversationProjectContext,
  setDesktopProjectRoot,
  getFileState,
}: {
  isAgentMode: boolean;
  conversationProjectContext: ConversationProjectContext | null | undefined;
  setDesktopProjectRoot: (root: string) => Promise<void>;
  getFileState: () => FileStateLike;
}): Promise<string> {
  if (!isAgentMode || !conversationProjectContext?.projectRoot) return "";
  const root = conversationProjectContext.projectRoot.trim().replace(/[\\/]+$/, "");
  if (!root) return "";
  await setDesktopProjectRoot(root);
  const fileState = getFileState();
  if (fileState.mode !== "disk" || fileState.root.replace(/[\\/]+$/, "") !== root) {
    await fileState.loadFromDisk(root);
  }
  return [
    "Current project:",
    `- Name: ${conversationProjectContext.projectName}`,
    `- Root: ${root}`,
    "- This conversation is scoped to this project.",
    "- Use project-relative paths for filesystem, package, terminal, and Git tools.",
  ].join("\n");
}
