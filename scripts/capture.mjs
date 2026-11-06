import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

// Captures reproductibles, avec une base de démonstration isolée des vrais repas.
const baseUrl = process.env.SCREENSHOT_BASE_URL || "http://127.0.0.1:3101";
const output = resolve(process.env.SCREENSHOT_DIR || "docs/screenshots");
const temporary = await mkdtemp(join(tmpdir(), "dumbfood-captures-"));
let server;
let browser;
try {
  if (!process.env.SCREENSHOT_BASE_URL) {
    server = spawn(process.execPath, ["build/server/index.js"], {
      env: {
        ...process.env,
        PORT: "3101",
        NODE_ENV: "production",
        DB_PATH: join(temporary, "demo.db"),
        ADMIN_PASSWORD: "demo-capture-password-only",
        SESSION_SECRET:
          "demo-capture-session-secret-not-for-production-0123456789",
        DEMO_DATA: "true",
        COOKIE_SECURE: "false",
        PUBLIC_URL: baseUrl,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    server.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null)
        throw new Error(`Le serveur a échoué : ${error}`);
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Le serveur de démonstration ne démarre pas.");
  }
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  await mkdir(output, { recursive: true });
  for (const [name, viewport, mobile] of [
    ["desktop", { width: 1440, height: 1040 }, false],
    ["mobile", { width: 390, height: 844 }, true],
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      isMobile: mobile,
      hasTouch: mobile,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/e/demo-raclette-entre-amis`);
    await page
      .getByRole("heading", { name: "Raclette entre amis", exact: true })
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `${name}.png`),
      fullPage: !mobile,
      animations: "disabled",
    });
    if (mobile) {
      await page.screenshot({
        path: join(output, "mobile-complet.png"),
        fullPage: true,
        animations: "disabled",
      });
      await context.request.post(`${baseUrl}/api/identity`, {
        data: { name: "Thomas" },
      });
      await page.reload();
      await page
        .locator(
          'summary[aria-label="Voir les apports pour Fromage à raclette"]',
        )
        .click();
      await page
        .getByRole("button", {
          name: "Modifier l’apport de Anne pour Fromage à raclette",
          exact: true,
        })
        .click();
      await page.getByRole("dialog").waitFor();
      await page.screenshot({
        path: join(output, "mobile-apport.png"),
        animations: "disabled",
      });
    }
    await context.close();
  }
  console.log(`Captures enregistrées dans ${output}`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
