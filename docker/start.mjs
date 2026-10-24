// Keep host development URLs usable when running inside Docker Desktop.
for (const key of ["DATABASE_URL", "REDIS_URL"]) {
  if (!process.env[key]) continue;
  const url = new URL(process.env[key]);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
    process.env[key] = url.href;
  }
}
// 后台配置的模型供应商地址同样如此：providerUrl 据此把本机地址改为宿主机。
process.env.NYZ_LOOPBACK_HOST ||= "host.docker.internal";

await import(new URL(`../${process.argv[2]}`, import.meta.url));
