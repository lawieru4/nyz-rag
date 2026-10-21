// Keep host development URLs usable when running inside Docker Desktop.
for (const key of ["DATABASE_URL", "REDIS_URL"]) {
  if (!process.env[key]) continue;
  const url = new URL(process.env[key]);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
    process.env[key] = url.href;
  }
}

await import(new URL(`../${process.argv[2]}`, import.meta.url));
