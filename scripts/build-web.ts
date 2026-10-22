import { mkdir, copyFile } from "node:fs/promises";
const result = await Bun.build({
  entrypoints: ["web/app.tsx"],
  outdir: "dist",
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await mkdir("dist", { recursive: true });
await copyFile("web/index.html", "dist/index.html");
console.log("React dashboard built");
