import { createHash } from "node:crypto";

import { GHOSTTY_SHA256, GHOSTTY_VERSION, GHOSTTY_WASM_BASE64 } from "./wasm.generated.js";

/* eslint-disable no-unused-vars */
export interface WasmMemory { buffer: ArrayBuffer; grow(pages: number): number }
export interface WasmTable { grow(count: number): number; set(index: number, value: unknown): void }
export type WasmFunction = (...args: Array<number | bigint>) => number;
interface WasmHost {
  Module: new (bytes: Uint8Array) => unknown;
  Instance: new (module: unknown, imports?: Record<string, Record<string, unknown>>) => { exports: Record<string, unknown> };
}
/* eslint-enable no-unused-vars */
export interface BitSpec {
  lsb: number;
  width: number;
  arms: Record<string, { bits: Record<string, BitSpec> }>;
}
export interface GhosttyType {
  size: number;
  fields: Record<string, { offset: number; size: number }>;
  values: Record<string, number>;
  bits: Record<string, BitSpec>;
}
export type GhosttyTypes = Record<string, GhosttyType>;
export interface GhosttyApi {
  memory: WasmMemory;
  table: WasmTable;
  functions: Record<string, WasmFunction>;
}

export const wasmHost = (globalThis as unknown as { WebAssembly: WasmHost }).WebAssembly;
export const REPLY_TRAMPOLINE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 8, 1, 96, 4, 127, 127, 127, 127, 0,
  2, 13, 1, 3, 101, 110, 118, 5, 114, 101, 112, 108, 121, 0, 0,
  7, 9, 1, 5, 114, 101, 112, 108, 121, 0, 0,
]);

export function instantiateGhostty(): { api: GhosttyApi; types: GhosttyTypes } {
  const bytes = Buffer.from(GHOSTTY_WASM_BASE64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== GHOSTTY_SHA256) throw new Error("Embedded Ghostty checksum mismatch.");
  const { exports } = new wasmHost.Instance(new wasmHost.Module(bytes));
  const memory = exports.memory as WasmMemory;
  const functions = Object.fromEntries(Object.entries(exports).filter(([, value]) => typeof value === "function")) as Record<string, WasmFunction>;
  const ptr = functions.ghostty_type_json!();
  const data = new Uint8Array(memory.buffer);
  const end = data.indexOf(0, ptr);
  if (ptr <= 0 || end < ptr) throw new Error("Invalid Ghostty ABI manifest.");
  const manifest = JSON.parse(new TextDecoder().decode(data.subarray(ptr, end))) as {
    schema: number; library_version: string; abi: { pointer_size: number; usize_size: number; endian: string }; types: GhosttyTypes;
  };
  if (manifest.schema !== 1 || manifest.library_version !== GHOSTTY_VERSION || manifest.abi.pointer_size !== 4 || manifest.abi.usize_size !== 4 || manifest.abi.endian !== "little") {
    throw new Error("Unsupported embedded Ghostty ABI.");
  }
  return { api: { memory, table: exports.__indirect_function_table as WasmTable, functions }, types: manifest.types };
}

export function ghosttyValue(types: GhosttyTypes, type: string, key: string): number {
  const result = types[type]?.values?.[key];
  if (result === undefined) throw new Error(`Ghostty ABI is missing ${type}.${key}.`);
  return result;
}

export function ghosttyOffset(types: GhosttyTypes, type: string, field: string): number {
  const result = types[type]?.fields?.[field]?.offset;
  if (result === undefined) throw new Error(`Ghostty ABI is missing ${type}.${field}.`);
  return result;
}
