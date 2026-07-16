import type { CraigConfig, PreviewFeatureId, RunnerType } from "../../domain/config/index.js";
import { configService } from "../../domain/config/index.js";
import type { ActionContext } from "./context.js";

export const saveRunnerEnabled = async (
  runner: RunnerType,
  enabled: boolean,
  ctx: ActionContext,
): Promise<CraigConfig> => {
  const next = configService.runners.setRunnerEnabled(ctx.config, runner, enabled);
  await configService.save(ctx.paths, next);
  return next;
};

export const saveRunnerPath = async (
  runner: RunnerType,
  executablePath: string | null,
  ctx: ActionContext,
): Promise<CraigConfig> => {
  const next = configService.runners.setRunnerPath(ctx.config, runner, executablePath);
  await configService.save(ctx.paths, next);
  return next;
};

export const savePreviewEnabled = async (
  feature: PreviewFeatureId,
  enabled: boolean,
  ctx: ActionContext,
): Promise<CraigConfig> => {
  const next = configService.previews.setEnabled(ctx.config, feature, enabled);
  await configService.save(ctx.paths, next);
  return next;
};
