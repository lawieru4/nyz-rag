import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt N=2^15, r=8：单次约 50～100 ms、占用 32 MiB 内存（OWASP 推荐的最低档）。
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const derive = (password: string, salt: Buffer, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) => {
  // 规范化后哈希，同一密码的不同 Unicode 写法（全角、组合字符）可以登录。
  scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
});

/** 格式：scrypt$N$r$p$salt$hash（base64），参数随哈希保存，便于日后调整强度。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** 账号不存在时也校验一次，使响应时间不暴露邮箱是否已注册。 */
export const dummyPasswordHash = () => dummy ??= hashPassword(randomBytes(16).toString("hex"));
