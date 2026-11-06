import { createApplication } from "./app.js";

const application = createApplication({
  databasePath:
    process.env.DB_PATH || process.env.DATABASE_PATH || "data/dumbfood.db",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  sessionSecret: process.env.SESSION_SECRET || "",
  demoData: process.env.DEMO_DATA === "true",
  production: process.env.NODE_ENV === "production",
  publicUrl: process.env.PUBLIC_URL,
  secureCookie:
    process.env.COOKIE_SECURE === undefined
      ? undefined
      : process.env.COOKIE_SECURE === "true",
});
const port = Number(process.env.PORT || 3000);
application.server.listen(port, "0.0.0.0", () =>
  console.log(`dumbfood prêt sur le port ${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void application.close().then(() => process.exit(0));
  });
