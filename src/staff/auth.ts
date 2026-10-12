import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "upnet_staff_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const failures = new Map<string, { count: number; until: number }>();

export type StaffRole = "agent" | "admin";
export type StaffActor = { id: string; email: string; displayName: string; role: StaffRole };
export type AuthenticatedSession = { actor: StaffActor; csrfToken: string; sessionId: string };

function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function parseCookies(value = "") {
  return Object.fromEntries(value.split(";").map((part) => part.trim().split("="))
    .filter((parts): parts is [string, string] => Boolean(parts[0] && parts[1]))
    .map(([key, val]) => [key, decodeURIComponent(val)]));
}
export function passwordHashFormat(hash: string, salt: string) { return `${hash}.${salt}`; }
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return passwordHashFormat(derived.toString("hex"), salt);
}
export async function verifyPassword(password: string, encoded: string) {
  const [hex, salt] = encoded.split(".");
  if (!hex || !salt) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function setSessionCookie(reply: { header: (name: string, value: string) => unknown }, token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}
export function clearSessionCookie(reply: { header: (name: string, value: string) => unknown }) {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
export function getSessionToken(headers: Record<string, string | string[] | undefined>) {
  const cookie = headers.cookie;
  return parseCookies(Array.isArray(cookie) ? cookie[0] : cookie)[SESSION_COOKIE];
}

export class StaffAuthService {
  constructor(private readonly pool: Pool) {}

  async createUser(email: string, displayName: string, password: string, role: StaffRole): Promise<StaffActor> {
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    const result = await this.pool.query<{ id: string; email: string; display_name: string; role: StaffRole }>(
      `INSERT INTO staff_users (id,email,display_name,password_hash,password_salt,role)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,display_name,role`,
      [id, email.toLowerCase().trim(), displayName.trim(), passwordHash.split(".")[0], passwordHash.split(".")[1], role],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Staff user creation failed");
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
  }

  async login(email: string, password: string, ip = "unknown") {
    const key = `${ip}:${email.toLowerCase()}`;
    const lock = failures.get(key);
    if (lock && lock.until > Date.now()) throw new Error("Login temporarily unavailable");
    const result = await this.pool.query<{ id: string; email: string; display_name: string; role: StaffRole; password_hash: string; password_salt: string }>(
      "SELECT id,email,display_name,role,password_hash,password_salt FROM staff_users WHERE email=$1 AND active=TRUE",
      [email.toLowerCase().trim()],
    );
    const row = result.rows[0];
    const valid = row && await verifyPassword(password, passwordHashFormat(row.password_hash, row.password_salt));
    if (!valid) {
      const count = (lock?.count ?? 0) + 1;
      failures.set(key, { count, until: Date.now() + Math.min(15 * 60_000, 500 * 2 ** Math.min(count, 10)) });
      throw new Error("Invalid credentials");
    }
    failures.delete(key);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    await this.pool.query(
      "INSERT INTO staff_sessions (id,staff_user_id,token_hash,csrf_token,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [sessionId, row.id, hashToken(token), csrfToken, new Date(Date.now() + SESSION_TTL_MS)],
    );
    return { token, csrfToken, sessionId, actor: { id: row.id, email: row.email, displayName: row.display_name, role: row.role } as StaffActor };
  }

  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedSession | undefined> {
    const token = getSessionToken(headers);
    if (!token) return undefined;
    const result = await this.pool.query<{ session_id: string; csrf_token: string; id: string; email: string; display_name: string; role: StaffRole }>(
      `SELECT s.id session_id,s.csrf_token,u.id,u.email,u.display_name,u.role
       FROM staff_sessions s JOIN staff_users u ON u.id=s.staff_user_id
       WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    await this.pool.query("UPDATE staff_sessions SET last_seen_at=NOW() WHERE id=$1", [row.session_id]);
    return { sessionId: row.session_id, csrfToken: row.csrf_token, actor: { id: row.id, email: row.email, displayName: row.display_name, role: row.role } };
  }
  async logout(headers: Record<string, string | string[] | undefined>) {
    const token = getSessionToken(headers);
    if (token) await this.pool.query("DELETE FROM staff_sessions WHERE token_hash=$1", [hashToken(token)]);
  }
}
export const STAFF_SESSION_COOKIE = SESSION_COOKIE;
