import { existsSync } from "node:fs";
import { clamp } from "./src/math.ts";

const checks = [
  [5, 0, 10, 5],
  [-2, 0, 10, 0],
  [14, 0, 10, 10],
] as const;

for (const [value, min, max, expected] of checks) {
  if (clamp(value, min, max) !== expected) {
    console.error(`FAIL: clamp(${value}, ${min}, ${max}) did not return ${expected}`);
    process.exit(1);
  }
}

let rejected = false;
try {
  clamp(5, 10, 0);
} catch {
  rejected = true;
}
if (!rejected) {
  console.error("FAIL: clamp accepted an inverted range");
  process.exit(1);
}
if (!existsSync("test/math.test.ts")) {
  console.error("FAIL: test/math.test.ts was not added");
  process.exit(1);
}

console.log("PASS");
