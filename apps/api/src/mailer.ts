import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close?(): void;
}

/**
 * 按 SMTP_* 环境变量创建发信器。未设置 SMTP_HOST 时：生产环境返回 null（注册与找回密码返回 503），
 * 其他环境把邮件内容写入 API 日志，便于本地调试。
 */
export function createMailer(log: FastifyBaseLogger): Mailer | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    if (process.env.NODE_ENV === "production") return null;
    return {
      async send(message) {
        log.warn({ mail: message }, "SMTP_HOST is not set; the email was logged instead of sent (development only)");
      },
    };
  }
  const from = process.env.MAIL_FROM?.trim();
  if (!from) throw new Error("MAIL_FROM is required when SMTP_HOST is set");
  const port = Number(process.env.SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  const secure = process.env.SMTP_SECURE;
  if (secure !== undefined && secure !== "true" && secure !== "false") throw new Error("SMTP_SECURE must be true or false");
  const user = process.env.SMTP_USER?.trim();
  const transport = nodemailer.createTransport({
    host, port,
    // 465 为隐式 TLS；其他端口在服务器支持时通过 STARTTLS 升级。
    secure: secure === undefined ? port === 465 : secure === "true",
    auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? "" } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return {
    async send(message) { await transport.sendMail({ from, ...message }); },
    close: () => transport.close(),
  };
}
