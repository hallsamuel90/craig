declare const __CRAIG_VERSION__: string | undefined;

export const getCurrent = (): string => {
  try {
    return typeof __CRAIG_VERSION__ !== "undefined" ? __CRAIG_VERSION__ : "unknown";
  } catch {
    return "unknown";
  }
};
