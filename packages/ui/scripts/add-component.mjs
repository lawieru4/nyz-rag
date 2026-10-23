// 用 shadcn-vue CLI 添加组件，再修正生成代码的导入：
// 组件以源码形式被 web/admin 直接引用，而各应用的 `@/` 指向自己的 src，因此一律改为相对路径。
// 同时统一为 LF 换行。CLI 在 monorepo 子包里解析不了 utils 别名，会写成 npm 包 "cn" 并把它装为依赖，这里一并改回并移除。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const shell = process.platform === "win32";
const args = process.argv.slice(2);

if (args.length) {
  const result = spawnSync("pnpm", ["dlx", "shadcn-vue@2", "add", ...args], { cwd: root, stdio: "inherit", shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|vue)$/.test(name)) yield path;
  }
}

for (const file of files(join(src, "components"))) {
  const before = readFileSync(file, "utf8");
  const after = before
    .replace(/\r\n/g, "\n")
    .replace(/(["'])cn\1/g, "$1@/lib/utils$1")
    .replace(/(["'])@\/([^"']+)\1/g, (_, quote, target) => {
      let path = relative(dirname(file), join(src, target)).split(sep).join("/");
      if (!path.startsWith(".")) path = `./${path}`;
      return `${quote}${path}${quote}`;
    });
  if (after !== before) writeFileSync(file, after);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.dependencies?.cn) spawnSync("pnpm", ["remove", "cn"], { cwd: root, stdio: "inherit", shell });
