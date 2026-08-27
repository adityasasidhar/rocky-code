export type User = { first: string; last: string };

export function getUserName(user: User): string {
  return `${user.first} ${user.last}`;
}
