export function validateAdminIdentity({ email, nickname }: { email: string; nickname: string }): string {
  if (!email.trim()) return "请输入邮箱";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "邮箱格式不正确";
  if (!nickname.trim()) return "请输入昵称";
  return "";
}

export function validateAdminPassword(password: string, label: "密码" | "新密码"): string {
  if (!password) return `请输入${label}`;
  if (password.length < 8) return `${label}至少 8 个字符`;
  if (password.length > 1024) return `${label}不能超过 1024 个字符`;
  return "";
}
