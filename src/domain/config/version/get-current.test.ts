import { describe, expect, test } from "vitest";
import { getCurrent } from "./get-current.js";

describe("getCurrent", () => {
  test("returns unknown when __CRAIG_VERSION__ is not defined in test environment", () => {
    expect(getCurrent()).toBe("unknown");
  });
});
