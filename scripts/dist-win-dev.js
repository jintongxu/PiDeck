/**
 * dist:win:dev 包装脚本：构建并打包独立的 Dev 验证版安装包。
 *
 * 与正式版完全隔离，互不影响：
 * - productName: PiDeck-Dev → 安装目录、快捷方式和窗口标题均带 Dev
 * - appId: com.ayuayue.pi-desktop-dev → 通知中心归属独立
 * - 构建标记: PIDECK_DEV_BUILD=1 → 运行时使用 %APPDATA%\pi-desktop-dev
 * - 输出目录: release-dev → 不覆盖 release/ 中的正式产物
 *
 * 注意：dev 与 dev 构建版共享开发配置目录，因此二者仍按开发版单实例规则互斥；
 * 但都不会抢占或打开正式版客户端。
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "release-dev");
// Never let an old temporary installer/unpacked EXE be mistaken for this build.
fs.rmSync(outputDir, { recursive: true, force: true });

console.log(`[1/3] 构建代码（注入 dev 构建标记）…`);
execSync("npm run build", {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: { ...process.env, PIDECK_DEV_BUILD: "1" },
});

console.log(`\n[2/3] electron-builder --win nsis → release-dev/ …`);
execSync(
	"npx electron-builder --win nsis --config scripts/electron-builder-dev.cjs",
	{
		cwd: root,
		stdio: "inherit",
		shell: true,
		env: { ...process.env, PIDECK_DEV_BUILD: "1" },
	},
);

const expectedSetup = path.join(outputDir, `PiDeck-Dev-${require(path.join(root, "package.json")).version}-temporary-setup.exe`);
if (!fs.existsSync(expectedSetup)) {
  throw new Error(`Temporary build did not produce the expected isolated installer: ${expectedSetup}`);
}
console.log(`\n[3/3] ✅ 临时 Dev 版打包完成！产物在 release-dev/ 目录（仅使用 *-temporary-setup.exe）`);
