import type { AppCommand } from "./types.js";
import type { AgentRuntimeState } from "../domain/agent/index.js";
import type { PromptCommandState } from "../domain/orchestration/index.js";
import { configService } from "../domain/config/index.js";
import { CraigError } from "../domain/error/index.js";

export interface CliGlobalOptions {
  json: boolean;
  noInput: boolean;
  workspaceRoot?: string;
  taskId?: string;
}

export interface ParsedArgvCommand {
  mode: "interactive" | "command";
  options: CliGlobalOptions;
  command?: AppCommand;
  commandName?: string;
}

export function parseArgv(argv: string[]): ParsedArgvCommand {
  const { commandTokens, options, help } = parseGlobalOptions(argv);

  if (help) {
    return commandResult({ kind: "help" }, options);
  }

  if (commandTokens.length === 0) {
    return { mode: "interactive", options };
  }

  const [group, action, ...args] = commandTokens;
  let command: AppCommand;

  switch (`${group ?? ""}:${action ?? ""}`) {
    case "context:show":
      requireNoArgs(args, "context show");
      command = { kind: "showContext" };
      break;
    case "repo:add":
      command = { kind: "addRepo", path: requireJoinedValue(args, "Repo path") };
      break;
    case "repo:list":
      requireNoArgs(args, "repo list");
      command = { kind: "listRepos" };
      break;
    case "repo:remove":
      command = { kind: "removeRepo", repoId: requireSingleValue(args, "Repo id") };
      break;
    case "workspace:add":
      command = { kind: "addWorkspace", path: requireJoinedValue(args, "Workspace path") };
      break;
    case "workspace:list":
      command = parseWorkspaceList(args);
      break;
    case "workspace:archive":
      command = { kind: "archiveWorkspace", workspaceId: requireSingleValue(args, "Workspace id") };
      break;
    case "workspace:restore":
      command = { kind: "restoreWorkspace", workspaceId: requireSingleValue(args, "Workspace id") };
      break;
    case "workspace:remove":
      command = { kind: "removeWorkspace", workspaceId: requireSingleValue(args, "Workspace id") };
      break;
    case "task:new":
      command = parseTaskNew(args);
      break;
    case "task:list":
      command = parseTaskList(args);
      break;
    case "task:current":
      requireNoArgs(args, "task current");
      command = { kind: "currentTask" };
      break;
    case "task:show":
      command = args.length === 0
        ? { kind: "showCurrentTask" }
        : { kind: "showTask", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:pr":
      command = parseTaskPr(args);
      break;
    case "task:wait":
      command = parseTaskWait(args);
      break;
    case "agent:list":
      requireNoArgs(args, "agent list");
      command = { kind: "listAgents" };
      break;
    case "agent:status":
      command = parseAgentStatus(args);
      break;
    case "agent:send":
      command = parseAgentSend(args);
      break;
    case "command:show":
      command = { kind: "showPromptCommand", commandId: requireSingleValue(args, "Command id") };
      break;
    case "command:list":
      requireNoArgs(args, "command list");
      command = { kind: "listPromptCommands" };
      break;
    case "command:cancel":
      command = { kind: "cancelPromptCommand", commandId: requireSingleValue(args, "Command id") };
      break;
    case "command:wait":
      command = parseCommandWait(args);
      break;
    case "events:list":
      command = parseEvents(args, false);
      break;
    case "events:watch":
      command = parseEvents(args, true);
      break;
    case "task:attach":
      command = { kind: "attachTask", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:logs":
      command = { kind: "streamTaskLogs", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:diff":
      command = { kind: "showTaskDiff", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:focus":
      command = { kind: "focusTask", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:open":
      command = { kind: "openTask", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:check":
      command = { kind: "runChecks", taskId: requireSingleValue(args, "Task id") };
      break;
    case "task:commit":
      command = { kind: "commitTask", taskId: requireSingleValue(args, "Task id") };
      break;
    case "link:add":
      command = {
        kind: "addTaskLink",
        taskId: requireValueAt(args, 0, "Task id"),
        repoId: requireValueAt(args, 1, "Repo id"),
      };
      requireExactLength(args, 2, "link add");
      break;
    case "link:list":
      command = { kind: "listTaskLinks", taskId: requireSingleValue(args, "Task id") };
      break;
    default:
      if (commandTokens.length === 1 && (group === "help" || group === "--help" || group === "-h")) {
        command = { kind: "help" };
        break;
      }
      throw usageError(`Unsupported command: ${commandTokens.join(" ")}`);
  }

  return commandResult(command, options);
}

export function hasJsonOutputFlag(argv: string[]): boolean {
  const input = argv[0] === "--" ? argv.slice(1) : argv;
  let parseOptions = true;
  for (const token of input) {
    if (token === "--") {
      parseOptions = false;
      continue;
    }
    if (parseOptions && token === "--json") {
      return true;
    }
  }
  return false;
}

export function getCommandName(command: AppCommand): string {
  const names: Record<AppCommand["kind"], string> = {
    addWorkspace: "workspace.add",
    addRepo: "repo.add",
    listRepos: "repo.list",
    removeRepo: "repo.remove",
    listWorkspaces: "workspace.list",
    archiveWorkspace: "workspace.archive",
    restoreWorkspace: "workspace.restore",
    removeWorkspace: "workspace.remove",
    createTask: "task.new",
    listTasks: "task.list",
    currentTask: "task.current",
    showTask: "task.show",
    showCurrentTask: "task.show",
    showTaskPr: "task.pr.show",
    discoverTaskPr: "task.pr.discover",
    linkTaskPr: "task.pr.link",
    refreshTaskPr: "task.pr.refresh",
    unlinkTaskPr: "task.pr.unlink",
    listAgents: "agent.list",
    showAgentStatus: "agent.status",
    sendAgentPrompt: "agent.send",
    showPromptCommand: "command.show",
    listPromptCommands: "command.list",
    cancelPromptCommand: "command.cancel",
    waitPromptCommand: "command.wait",
    waitTask: "task.wait",
    listEvents: "events.list",
    watchEvents: "events.watch",
    attachTask: "task.attach",
    addTaskLink: "link.add",
    listTaskLinks: "link.list",
    refreshInteractiveState: "interactive.refresh",
    showSelectedTask: "task.show",
    streamTaskLogs: "task.logs",
    streamSelectedTaskLogs: "task.logs",
    showTaskDiff: "task.diff",
    showSelectedTaskDiff: "task.diff",
    focusTask: "task.focus",
    focusSelectedTask: "task.focus",
    openTask: "task.open",
    openSelectedTask: "task.open",
    runChecks: "task.check",
    runSelectedTaskChecks: "task.check",
    commitTask: "task.commit",
    commitSelectedTask: "task.commit",
    showContext: "context.show",
    help: "help",
    exit: "exit",
  };
  return names[command.kind];
}

export function getHelpText(): string {
  return [
    "Craig commands:",
    "  craig [--workspace-root <path>] [--task <id>] [--json] [--no-input] <command>",
    "  craig context show       Show resolved workspace, task, and agent-tab context",
    "  craig repo add <path>    Register a repo in the current Craig workspace",
    "  craig workspace add <path>  Register a repo or parent-directory workspace",
    "  craig repo list          List registered repos",
    "  craig repo remove <id>   Remove a registered repo",
    "  craig workspace list [--archived]  List workspaces",
    "  craig workspace archive <id>  Archive a workspace",
    "  craig workspace restore <id>  Restore an archived workspace",
    "  craig workspace remove <id>  Remove an archived workspace",
    "  craig task new --repo <repo-id> [--runner codex|cursor|claude] <prompt>",
    "  craig task new --workspace <workspace-id> [--runner codex|cursor|claude] <prompt>",
    "  craig task list [--repo <repo-id>]  List known Craig tasks",
    "  craig task current       Show the task resolved from flags, environment, or cwd",
    "  craig task show [<id>]   Show task details; omit id to use resolved context",
    "  craig task pr show [<id>] [--repo <repo-id>]",
    "  craig task pr discover [<id>] [--repo <repo-id>]",
    "  craig task pr link [<id>] --pr <url|number> [--repo <repo-id>]",
    "  craig task pr refresh [<id>] [--repo <repo-id>]",
    "  craig task pr unlink [<id>] --pr <url|number> [--repo <repo-id>]",
    "  craig agent list [--task <task-id>]  List agent-tab and task roll-up states",
    "  craig agent status [--task <task-id>] [--tab <tab-id>]  Show agent state details",
    "  craig agent send --task <task-id> [--tab <tab-id>] (--prompt <text> | --prompt-file <path> | --stdin)",
    "    [--delivery when-ready|immediate] [--timeout <duration>] [--idempotency-key <key>]",
    "  craig command show <command-id>  Show a durable prompt command",
    "  craig command list [--task <task-id>]  List durable prompt commands",
    "  craig command cancel <command-id>  Cancel a queued prompt command",
    "  craig command wait <command-id> [--state <states>] [--timeout <duration>]",
    "  craig task wait [<id>] --state <states> [--tab <tab-id>] [--timeout <duration>]",
    "  craig events list [--task <task-id>] [--type <glob>] [--after <cursor>] --json",
    "  craig events watch [--task <task-id>] [--type <glob>] [--after <cursor>] [--format jsonl]",
    "  craig task logs <id>     Stream Craig-managed logs for a task",
    "  craig task diff <id>     Show the current worktree diff for a task",
    "  craig task attach <id>   Attach to a live task session",
    "  craig task focus <id>    Focus the tmux pane for a task",
    "  craig task open <id>     Open the task worktree or print its path",
    "  craig task check <id>    Run configured checks for a task",
    "  craig task commit <id>   Commit all task worktree changes",
    "  craig link add <task-id> <repo-id>  Add a linked repo to a task",
    "  craig link list <task-id>  List linked repos for a task",
  ].join("\n");
}

function parseGlobalOptions(argv: string[]): {
  commandTokens: string[];
  options: CliGlobalOptions;
  help: boolean;
} {
  const input = [...argv];
  if (input[0] === "--") {
    input.shift();
  }

  const commandTokens: string[] = [];
  const options: CliGlobalOptions = { json: false, noInput: false };
  const seen = new Set<string>();
  let help = false;
  let parseOptions = true;

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--") {
      parseOptions = false;
      commandTokens.push(token);
      continue;
    }

    if (!parseOptions || !isGlobalOption(token)) {
      commandTokens.push(token);
      continue;
    }

    if (seen.has(token)) {
      throw usageError(`Global option ${token} may only be provided once.`);
    }
    seen.add(token);

    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--no-input") {
      options.noInput = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    const value = input[index + 1];
    if (value === undefined || value === "--" || isGlobalOption(value)) {
      throw usageError(`Global option ${token} requires a value.`);
    }
    index += 1;

    if (token === "--workspace-root") {
      options.workspaceRoot = requireNonEmpty(value, "Workspace root");
    } else {
      options.taskId = requireNonEmpty(value, "Task id");
    }
  }

  return { commandTokens, options, help };
}

function parseWorkspaceList(args: string[]): AppCommand {
  if (args.length === 0) {
    return { kind: "listWorkspaces", archived: false };
  }
  if (args.length === 1 && args[0] === "--archived") {
    return { kind: "listWorkspaces", archived: true };
  }
  throw usageError(`Unsupported command: workspace list ${args.join(" ")}`);
}

function parseTaskList(args: string[]): AppCommand {
  if (args.length === 0) {
    return { kind: "listTasks" };
  }
  if (args.length === 2 && args[0] === "--repo") {
    return { kind: "listTasks", repoId: requireNonEmpty(args[1]!, "Repo id") };
  }
  throw usageError(`Unsupported command: task list ${args.join(" ")}`);
}

function parseTaskNew(args: string[]): AppCommand {
  let repoId: string | undefined;
  let workspaceId: string | undefined;
  let runner: ReturnType<typeof configService.runners.parse> | undefined;
  const promptParts: string[] = [];
  let parseOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      parseOptions = false;
      continue;
    }
    if (!parseOptions || !["--repo", "--workspace", "--runner"].includes(token)) {
      if (parseOptions && token.startsWith("--")) {
        throw usageError(`Unsupported task new option: ${token}`);
      }
      promptParts.push(token);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value === "--") {
      throw usageError(`Task option ${token} requires a value.`);
    }
    index += 1;

    if (token === "--repo") {
      if (repoId !== undefined) throw usageError("Task option --repo may only be provided once.");
      repoId = requireNonEmpty(value, "Repo id");
    } else if (token === "--workspace") {
      if (workspaceId !== undefined) throw usageError("Task option --workspace may only be provided once.");
      workspaceId = requireNonEmpty(value, "Workspace id");
    } else {
      if (runner !== undefined) throw usageError("Task option --runner may only be provided once.");
      try {
        runner = configService.runners.parse(value);
      } catch (error) {
        throw usageError(error instanceof Error ? error.message : "Unsupported runner.");
      }
    }
  }

  if (!repoId && !workspaceId) {
    throw usageError("Task creation requires '--repo <repo-id>' or '--workspace <workspace-id>'.");
  }
  if (repoId && workspaceId) {
    throw usageError("Task creation accepts either '--repo' or '--workspace', not both.");
  }

  const prompt = requireNonEmpty(promptParts.join(" "), "Task prompt");
  return {
    kind: "createTask",
    ...(repoId ? { repoId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(runner ? { runner } : {}),
    prompt,
  };
}

function parseTaskPr(args: string[]): AppCommand {
  const [action, ...commandArgs] = args;
  if (!["show", "discover", "link", "refresh", "unlink"].includes(action ?? "")) {
    throw usageError(`Unsupported command: task pr ${args.join(" ")}`);
  }

  let taskId: string | undefined;
  let repoId: string | undefined;
  let pullRequest: string | undefined;
  for (let index = 0; index < commandArgs.length; index += 1) {
    const token = commandArgs[index]!;
    if (token !== "--repo" && token !== "--pr") {
      if (token.startsWith("--")) {
        throw usageError(`Unsupported task pr ${action} option: ${token}`);
      }
      if (taskId !== undefined) {
        throw usageError(`task pr ${action} accepts at most one task id.`);
      }
      taskId = requireNonEmpty(token, "Task id");
      continue;
    }

    const value = commandArgs[index + 1];
    if (value === undefined || value === "--") {
      throw usageError(`Task PR option ${token} requires a value.`);
    }
    index += 1;
    if (token === "--repo") {
      if (repoId !== undefined) {
        throw usageError("Task PR option --repo may only be provided once.");
      }
      repoId = requireNonEmpty(value, "Repo id");
    } else {
      if (pullRequest !== undefined) {
        throw usageError("Task PR option --pr may only be provided once.");
      }
      pullRequest = requireNonEmpty(value, "Pull request selector");
    }
  }

  if ((action === "link" || action === "unlink") && pullRequest === undefined) {
    throw usageError(`task pr ${action} requires --pr <url|number>.`);
  }
  if (action !== "link" && action !== "unlink" && pullRequest !== undefined) {
    throw usageError(`task pr ${action} does not accept --pr.`);
  }

  const target = {
    ...(taskId ? { taskId } : {}),
    ...(repoId ? { repoId } : {}),
  };
  switch (action) {
    case "show": return { kind: "showTaskPr", ...target };
    case "discover": return { kind: "discoverTaskPr", ...target };
    case "link": return { kind: "linkTaskPr", ...target, pullRequest: pullRequest! };
    case "refresh": return { kind: "refreshTaskPr", ...target };
    case "unlink": return { kind: "unlinkTaskPr", ...target, pullRequest: pullRequest! };
    default: throw usageError(`Unsupported command: task pr ${args.join(" ")}`);
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1_000;
const AGENT_STATES = new Set(["idle", "working", "ready", "error"]);
const PROMPT_COMMAND_STATES = new Set(["queued", "delivering", "delivered", "failed", "cancelled"]);

function parseAgentStatus(args: string[]): AppCommand {
  if (args.length === 0) return { kind: "showAgentStatus" };
  if (args.length === 2 && args[0] === "--tab") {
    return { kind: "showAgentStatus", tabId: requireNonEmpty(args[1]!, "Agent tab id") };
  }
  throw usageError(`Unsupported command: agent status ${args.join(" ")}`);
}

function parseAgentSend(args: string[]): AppCommand {
  let prompt: Extract<AppCommand, { kind: "sendAgentPrompt" }>["prompt"] | undefined;
  let tabId: string | undefined;
  let delivery: "when-ready" | "immediate" = "when-ready";
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let idempotencyKey: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!["--prompt", "--prompt-file", "--stdin", "--tab", "--delivery", "--timeout", "--idempotency-key"].includes(option)) {
      throw usageError(`Unsupported agent send option: ${option}`);
    }
    if (seen.has(option)) throw usageError(`Agent send option ${option} may only be provided once.`);
    seen.add(option);
    if (option === "--stdin") {
      if (prompt) throw usageError("Agent send accepts exactly one prompt source.");
      prompt = { source: "stdin" };
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`Agent send option ${option} requires a value.`);
    index += 1;
    if (option === "--prompt" || option === "--prompt-file") {
      if (prompt) throw usageError("Agent send accepts exactly one prompt source.");
      prompt = option === "--prompt"
        ? { source: "inline", text: requireNonEmpty(value, "Prompt") }
        : { source: "file", path: requireNonEmpty(value, "Prompt file") };
    } else if (option === "--tab") tabId = requireNonEmpty(value, "Agent tab id");
    else if (option === "--delivery") {
      if (value !== "when-ready" && value !== "immediate") {
        throw usageError('Agent send delivery must be "when-ready" or "immediate".');
      }
      delivery = value;
    } else if (option === "--timeout") timeoutMs = parseDuration(value);
    else idempotencyKey = requireNonEmpty(value, "Idempotency key");
  }

  if (!prompt) throw usageError("Agent send requires --prompt, --prompt-file, or --stdin.");
  return {
    kind: "sendAgentPrompt",
    prompt,
    delivery,
    timeoutMs,
    ...(tabId ? { tabId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function parseCommandWait(args: string[]): AppCommand {
  const commandId = requireNonEmpty(args[0] ?? "", "Command id");
  let states: PromptCommandState[] | undefined;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index]!;
    if (option !== "--state" && option !== "--timeout") throw usageError(`Unsupported command wait option: ${option}`);
    if (seen.has(option)) throw usageError(`Command wait option ${option} may only be provided once.`);
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`Command wait option ${option} requires a value.`);
    index += 1;
    if (option === "--state") states = parsePromptCommandStates(value);
    else timeoutMs = parseDuration(value);
  }
  return { kind: "waitPromptCommand", commandId, ...(states ? { states } : {}), timeoutMs };
}

function parsePromptCommandStates(value: string): PromptCommandState[] {
  const states = value.split(",").map((state) => state.trim()).filter(Boolean);
  if (states.length === 0 || states.some((state) => !PROMPT_COMMAND_STATES.has(state))) {
    throw usageError(`Invalid command state list "${value}". Use queued, delivering, delivered, failed, or cancelled.`);
  }
  return [...new Set(states)] as PromptCommandState[];
}

function parseEvents(args: string[], watch: boolean): AppCommand {
  let typeGlob: string | undefined;
  let after: string | undefined;
  let format: "human" | "jsonl" = "human";
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!["--type", "--after", "--format"].includes(option)) {
      throw usageError(`Unsupported events ${watch ? "watch" : "list"} option: ${option}`);
    }
    if (!watch && option === "--format") throw usageError("--format is supported only by events watch.");
    if (seen.has(option)) throw usageError(`Events option ${option} may only be provided once.`);
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`Events option ${option} requires a value.`);
    index += 1;
    if (option === "--type") typeGlob = requireNonEmpty(value, "Event type glob");
    else if (option === "--after") after = requireNonEmpty(value, "Event cursor");
    else if (value === "jsonl") format = "jsonl";
    else throw usageError('Events watch format must be "jsonl".');
  }
  const filters = { ...(typeGlob ? { typeGlob } : {}), ...(after ? { after } : {}) };
  return watch ? { kind: "watchEvents", ...filters, format } : { kind: "listEvents", ...filters };
}

function parseTaskWait(args: string[]): AppCommand {
  let taskId: string | undefined;
  let states: AgentRuntimeState[] | undefined;
  let tabId: string | undefined;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!["--state", "--tab", "--timeout"].includes(token)) {
      if (token.startsWith("--")) throw usageError(`Unsupported task wait option: ${token}`);
      if (taskId !== undefined) throw usageError("task wait accepts at most one task id.");
      taskId = requireNonEmpty(token, "Task id");
      continue;
    }
    if (seen.has(token)) throw usageError(`Task wait option ${token} may only be provided once.`);
    seen.add(token);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Task wait option ${token} requires a value.`);
    }
    index += 1;
    if (token === "--state") states = parseAgentStates(value);
    else if (token === "--tab") tabId = requireNonEmpty(value, "Agent tab id");
    else timeoutMs = parseDuration(value);
  }

  if (!states) throw usageError("task wait requires --state <idle|working|ready|error>[,...].");
  return { kind: "waitTask", ...(taskId ? { taskId } : {}), states, ...(tabId ? { tabId } : {}), timeoutMs };
}

function parseAgentStates(value: string): AgentRuntimeState[] {
  const states = value.split(",").map((state) => state.trim()).filter(Boolean);
  if (states.length === 0 || states.some((state) => !AGENT_STATES.has(state))) {
    throw usageError(`Invalid agent state list "${value}". Use idle, working, ready, or error.`);
  }
  return [...new Set(states)] as AgentRuntimeState[];
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw usageError(`Invalid duration "${value}". Use values such as 500ms, 30s, 5m, or 1h.`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw usageError(`Duration "${value}" is too large.`);
  return milliseconds;
}

function commandResult(command: AppCommand, options: CliGlobalOptions): ParsedArgvCommand {
  return { mode: "command", command, commandName: getCommandName(command), options };
}

function isGlobalOption(value: string): boolean {
  return ["--json", "--no-input", "--workspace-root", "--task", "--help", "-h"].includes(value);
}

function requireNoArgs(args: string[], commandName: string): void {
  requireExactLength(args, 0, commandName);
}

function requireExactLength(args: string[], length: number, commandName: string): void {
  if (args.length !== length) {
    throw usageError(`Command ${commandName} received an unexpected number of arguments.`);
  }
}

function requireSingleValue(args: string[], label: string): string {
  if (args.length !== 1) {
    throw usageError(`${label} is required and must be provided once.`);
  }
  return requireNonEmpty(args[0]!, label);
}

function requireJoinedValue(args: string[], label: string): string {
  return requireNonEmpty(args.join(" "), label);
}

function requireValueAt(args: string[], index: number, label: string): string {
  return requireNonEmpty(args[index] ?? "", label);
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw usageError(`${label} cannot be empty.`);
  }
  return normalized;
}

function usageError(message: string): CraigError {
  return new CraigError("CLI_USAGE", `${message}\n\n${getHelpText()}`, {});
}
