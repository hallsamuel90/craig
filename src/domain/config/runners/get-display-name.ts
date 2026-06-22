import type { RunnerType } from "../types.js";
import { getProfile } from "./get-profile.js";

export const getDisplayName = (runner: RunnerType): string => getProfile(runner).displayName;
