import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../.secrets/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const name of ["postgres_password", "postgres_admin_password"]) {
  const path = new URL(name, directory);
  try { writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    if (!readFileSync(path, "utf8").trim()) throw new Error(`Пустой файл ${name}: пароль не перезаписан`);
  }
}
console.log("PostgreSQL secrets готовы; существующие пароли сохранены, значения не выводятся.");
