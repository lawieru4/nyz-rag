// 后台配置的密钥（文章接口 token、模型供应商密钥）加密后入库：AES-256-GCM，主密钥取自环境变量 NYZ_SECRET_KEY（API 与 Worker 相同）。
// 密文绑定用途（context 作为附加认证数据），不能挪作他用；错误信息不包含密钥或密文。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const MIN_KEY_LENGTH = 32;

/** 主密钥缺失、过短，或密文无法用当前主密钥解密（主密钥已更换或数据损坏）。 */
export class SecretKeyError extends Error {}

export const providerSecretContext = (providerId: string) => `model-provider:${providerId}`;

function masterKey(): Buffer {
  const secret = process.env.NYZ_SECRET_KEY?.trim() ?? "";
  if (!secret) throw new SecretKeyError("未配置 NYZ_SECRET_KEY，无法保存或读取后台配置的密钥");
  if (secret.length < MIN_KEY_LENGTH) throw new SecretKeyError(`NYZ_SECRET_KEY 至少需要 ${MIN_KEY_LENGTH} 个字符`);
  return createHash("sha256").update(secret).digest();
}

/** 主密钥是否可用（缺失或过短时为 false），供后台提示。 */
export function secretKeyConfigured(): boolean {
  try { masterKey(); return true; } catch { return false; }
}

export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(payload: string, context: string): string {
  const key = masterKey();
  const [version, iv, tag, data] = payload.split(":");
  try {
    if (version !== VERSION || !iv || !tag || data === undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError("已保存的密钥无法解密（NYZ_SECRET_KEY 可能已更换），请在管理后台重新填写");
  }
}
