import { AsyncLocalStorage } from "node:async_hooks";
export const runtimeMutationContext = new AsyncLocalStorage<string>();
