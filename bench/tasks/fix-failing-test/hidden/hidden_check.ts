import { add } from "./src/math.ts";

const cases = [
  [-4, 9, 5],
  [0, 0, 0],
  [12, -7, 5],
] as const;

for (const [a, b, expected] of cases) {
  if (add(a, b) !== expected) {
    console.error(`FAIL: add(${a}, ${b}) did not return ${expected}`);
    process.exit(1);
  }
}

console.log("PASS");
