import { greeting } from "./src/greeting.ts";
import { formatUserName } from "./src/user.ts";

const user = { first: "Grace", last: "Hopper" };
if (formatUserName(user) !== "Grace Hopper") {
  console.error("FAIL: formatUserName returned the wrong value");
  process.exit(1);
}
if (greeting(user) !== "Hello, Grace Hopper!") {
  console.error("FAIL: greeting did not use the renamed function");
  process.exit(1);
}

const sources = await Promise.all([
  Bun.file("src/user.ts").text(),
  Bun.file("src/greeting.ts").text(),
]);
if (sources.some((source) => source.includes("getUserName"))) {
  console.error("FAIL: the old exported name is still present");
  process.exit(1);
}

console.log("PASS");
