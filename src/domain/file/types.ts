export interface CommandOpenFileResult {
  kind: "openFile";
  path: string;
  delivered: boolean;
}
