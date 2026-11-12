import type { Thread } from "./model";

export type ThreadReply = { thread: string; body: string; resolve: boolean };

// Agents with a read-only GitHub token return their review replies in their result, and the controller
// posts them with its own login. Only threads on this PR are accepted, one reply each.
export function parseReplies(value: unknown, threads: Thread[]): ThreadReply[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(threads.map(t => t.id));
  const replies = new Map<string, ThreadReply>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object" || typeof item.thread !== "string" || typeof item.body !== "string" || !known.has(item.thread) || replies.has(item.thread)) continue;
    const body = item.body.trim().slice(0, 4000);
    if (!body) continue;
    replies.set(item.thread, { thread: item.thread, body: /via Woodshed\W*$/i.test(body) ? body : `${body}\n\nvia Woodshed`, resolve: item.resolve === true });
  }
  return [...replies.values()];
}
