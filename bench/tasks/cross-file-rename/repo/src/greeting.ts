import { getUserName, type User } from "./user.ts";

export function greeting(user: User): string {
  return `Hello, ${getUserName(user)}!`;
}
