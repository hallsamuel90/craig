export interface CommandShowContextResult {
  kind: "showContext";
  workspace: {
    root: string;
    source: "explicit" | "environment" | "ancestor" | "git_common_dir" | "cwd";
    initialized: boolean;
  };
  task: {
    id: string;
    source: "explicit" | "environment" | "cwd";
    agentTabId: string | null;
  } | null;
}
