import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";

export function supportDirectory(): string {
  return process.platform === "darwin" ? join(homedir(), "Library/Application Support/Woodshed") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "woodshed");
}
export function defaultTokenPath(): string { return join(supportDirectory(), "api-token"); }
export type Connection = { url: string; token_path: string; machine: string };
export function validateConnection(input: unknown): Connection {
  const value = input as Partial<Connection>;
  const url = new URL(value.url ?? "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || typeof value.token_path !== "string" || !isAbsolute(value.token_path) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.machine ?? "")) throw new Error("Invalid Woodshed controller connection");
  return { url: url.origin, token_path: value.token_path, machine: value.machine! };
}
export function controllerConnection(path = join(supportDirectory(), "controller.json")): Connection | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 4096 || stat.mode & 0o022) throw new Error("The controller connection file must be owned by you and not writable by others");
  return validateConnection(JSON.parse(readFileSync(path, "utf8")));
}
