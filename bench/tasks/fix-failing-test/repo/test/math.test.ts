import { expect, test } from "bun:test";
import { add } from "../src/math.ts";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
