import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../.env", import.meta.url));
const contents = [
  "# Fichier privé : ne pas committer ni partager.",
  `ADMIN_PASSWORD=${randomBytes(24).toString("base64url")}`,
  `SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
  "",
  "PORT=3000",
  "HOST_BIND=0.0.0.0",
  "COOKIE_SECURE=false",
  "PUBLIC_URL=",
  "DEMO_DATA=false",
  "",
].join("\n");

try {
  writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
  console.log(".env créé avec des secrets uniques et des permissions privées.");
  console.log(
    "Le mot de passe administrateur se trouve dans .env, champ ADMIN_PASSWORD.",
  );
  console.log("Démarrage : docker compose up -d --build");
  console.log("Administration : http://localhost:3000/admin");
} catch (error) {
  if (error && error.code === "EEXIST") {
    console.error(".env existe déjà : aucune modification effectuée.");
  } else {
    console.error("Impossible de créer .env :", error.message);
  }
  process.exitCode = 1;
}
