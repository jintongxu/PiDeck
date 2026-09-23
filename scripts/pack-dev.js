/**
 * 开发验证打包：固定输出到 release-dev/，不碰 release/（运行中的正式/便携进程
 * 锁着 release/ 下的 exe，electron-builder 写同名文件会报占用）。
 *
 * 用法：
 *   npm run pack:dev                 → win-unpacked（最快，默认）
 *   npm run pack:dev -- portable     → 便携 exe 到 release-dev/
 *   npm run pack:dev -- nsis         → NSIS 安装包到 release-dev/
 *   npm run pack:dev -- dir portable
 *
 * 数据目录提示：便携版数据 = exe 同级 data/；临时版还使用
 * %APPDATA%/pi-desktop-dev，和正式版完全分离。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");

// 与 package.json 的 directories.output 区分开的独立 dev 输出目录。
// 如需换成别的名字，只改这里即可。
const DEV_OUTPUT_DIR = "release-dev";

// Remove stale setup/unpacked artifacts before every temporary build. A stale
// executable was previously easy to launch by mistake and could look like the
// formal client because both versions render the same main page.
fs.rmSync(path.join(root, DEV_OUTPUT_DIR), { recursive: true, force: true });

const args = process.argv.slice(2);
// 默认 --dir（win-unpacked 目录，秒级验证）；传了格式参数就用传入的
const formats = args.length > 0 ? args.join(" ") : "--dir";

console.log(`[1/2] 打包代码（注入临时版隔离标记）…`);
execSync("npm run build", {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PIDECK_DEV_BUILD: "1" },
});

console.log(`\n[2/2] electron-builder --win ${formats} → ${DEV_OUTPUT_DIR}/ …`);
execSync(
  `npx electron-builder --win ${formats} --config scripts/electron-builder-dev.cjs`,
  {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PIDECK_DEV_BUILD: "1" },
  },
);

const outDir = path.join(root, DEV_OUTPUT_DIR);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const requestedFormats = new Set(args.map((arg) => arg.replace(/^--/, "").toLowerCase()));
if (requestedFormats.has("portable")) {
  const expectedPortable = path.join(outDir, `PiDeck-Dev-${version}-temporary-portable.exe`);
  if (!fs.existsSync(expectedPortable)) {
    throw new Error(`Temporary build did not produce the expected isolated portable EXE: ${expectedPortable}`);
  }
}
console.log(`\n✅ 打包完成，产物在 ${DEV_OUTPUT_DIR}/`);
if (fs.existsSync(outDir)) {
  const files = fs.readdirSync(outDir).filter((name) => !/\.(blockmap|yml)$/.test(name) && !name.startsWith("."));
  for (const name of files) console.log(`  - ${name}`);
}
console.log(`\n提示：这是独立临时版，名称为 PiDeck-Dev，数据目录与正式版分离，不影响 release/。`);
console.log(`验证通过、关掉旧进程后，正式产物仍用 npm run pack / npm run dist:win。`);
