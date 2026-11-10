import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultTokenPath } from "./connection";

export function loadAPIToken(path = process.env.WOODSHED_TOKEN_PATH ?? defaultTokenPath()): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 256) throw new Error("Invalid Woodshed API credential file");
    fchmodSync(fd, 0o600);
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Woodshed API credential");
    return token;
  } finally { closeSync(fd); }
}
export function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  return !request.headers.has("origin") && Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
