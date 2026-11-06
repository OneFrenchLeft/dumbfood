import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
const tmp = await mkdtemp(join(tmpdir(), "dumbfood-ui-"));
const base = "http://127.0.0.1:3102";
const password = "browser-check-password-only";
const child = spawn(process.execPath, ["build/server/index.js"], {
  env: {
    ...process.env,
    PORT: "3102",
    DB_PATH: join(tmp, "db.sqlite"),
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "browser-check-session-secret-only-01234567890123456789",
    NODE_ENV: "production",
    PUBLIC_URL: base,
    COOKIE_SECURE: "false",
    DEMO_DATA: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (x) => (logs += x));
child.stderr.on("data", (x) => (logs += x));
let browser;
async function openOptions(page) {
  await page.getByRole("button", { name: "Options du repas", exact: true }).click();
}
async function optionsAction(page, action) {
  await openOptions(page);
  await page.getByRole("dialog").getByRole("button", { name: action, exact: true }).click();
}
async function chooseMeal(page) {
  if (await page.getByRole("button", { name: "Options du repas", exact: true }).count()) {
    await optionsAction(page, "Choisir un repas");
  } else {
    await page.getByRole("button", { name: "Choisir un repas", exact: true }).click();
  }
}
async function expandItem(page, name) {
  const summary = page.getByLabel(`Voir les apports pour ${name}`, { exact: true });
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error(logs);
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const admin = await browser.newContext({
    viewport: { width: 1440, height: 1040 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  const errors = [];
  const page = await admin.newPage();
  page.on("pageerror", (x) => errors.push(x.message));
  await page.goto(base + "/admin");
  await page.locator("#admin-password").fill(password);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await page.getByRole("main").getByRole("button", { name: "Nouveau repas", exact: true }).click();
  await page.locator("#event-title").fill("Repas de vérification");
  await page.locator("#event-date").fill("2026-11-21T19:30");
  await page.locator("#event-location").fill("Chez Anne");
  await page.getByRole("dialog").getByRole("button", { name: "Créer", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Repas de vérification", exact: true }),
  ).toBeVisible();
  const url = page.url();
  await page.locator(".add-item-end").click();
  await page.locator("#item-name").fill("Fromage");
  await page.getByLabel("Définir un objectif", { exact: false }).check();
  await page
    .getByRole("spinbutton", { name: "Objectif", exact: true })
    .fill("2400");
  await page.locator("#item-first-quantity").fill("1200");
  await page.locator("#contribution-name").fill("Anne");
  await page.getByRole("dialog").getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fromage", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".item-card")
      .filter({
        has: page.getByRole("heading", { name: "Fromage", exact: true }),
      }),
  ).toContainText("50 %");
  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  const phone = await guest.newPage();
  phone.on("pageerror", (x) => errors.push(x.message));
  await phone.goto(url);
  await expect(
    phone.getByRole("heading", { name: "Fromage", exact: true }),
  ).toBeVisible();
  await openOptions(phone);
  await expect(
    phone.getByRole("dialog").getByRole("button", { name: "Modifier le repas", exact: true }),
  ).toHaveCount(0);
  await phone.getByRole("dialog").getByRole("button", { name: "Fermer", exact: true }).click();
  await expect(phone.locator(".item-details").first()).not.toHaveAttribute("open");
  await expandItem(phone, "Fromage");
  await expect(
    phone.getByRole("button", { name: "Modifier Fromage", exact: true }),
  ).toHaveCount(0);
  await phone
    .getByRole("button", {
      name: "Modifier l’apport de Anne pour Fromage",
      exact: true,
    })
    .click();
  await phone.locator("#identity-name").fill("Thomas");
  await phone.getByRole("dialog").getByRole("button", { name: "Continuer", exact: true }).click();
  await phone.locator("#contribution-quantity").fill("2640");
  await phone.getByRole("dialog").getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.locator(".item-card").first()).toContainText("110 %");
  await expect(phone.locator(".item-card").first()).toContainText("110 %");
  await phone.locator(".add-item-end").click();
  await phone.locator("#item-name").fill("Pain");
  await phone.locator("#item-unit").selectOption("piece");
  await phone.locator("#item-first-quantity").fill("2");
  await expect(
    phone.getByLabel("Définir un objectif", { exact: false }),
  ).toHaveCount(0);
  await phone.locator("#contribution-person").selectOption({ label: "Anne" });
  await phone.getByRole("dialog").getByRole("button", { name: "Ajouter", exact: true }).click();
  const bread = page
    .locator(".item-card")
    .filter({ has: page.getByRole("heading", { name: "Pain", exact: true }) });
  await expect(bread).toBeVisible();
  await expect(bread.locator(".quantity-row")).toHaveText("2 pièces");
  await expect(bread.getByRole("progressbar")).toHaveCount(0);
  await expandItem(page, "Pain");
  await page
    .getByRole("button", { name: "Modifier Pain", exact: true })
    .click();
  await page.getByLabel("Définir un objectif", { exact: false }).check();
  await page
    .getByRole("spinbutton", { name: "Objectif", exact: true })
    .fill("3");
  await page.getByRole("dialog").getByRole("button", { name: "Enregistrer", exact: true }).click();
  const phoneBread = phone
    .locator(".item-card")
    .filter({ has: phone.getByRole("heading", { name: "Pain", exact: true }) });
  await expect(phoneBread).toContainText("67 %");
  await phone.getByRole("tab", { name: "Personnes", exact: true }).click();
  await expect(
    phone
      .locator(".person-card")
      .filter({
        has: phone.getByRole("heading", { name: "Anne", exact: true }),
      }),
  ).toContainText("Pain");
  await phone.getByRole("tab", { name: "Liste", exact: true }).click();
  await phone.getByRole("button", { name: "Afficher les éléments manquants", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Afficher les éléments manquants", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(
    phone.getByRole("heading", { name: "Fromage", exact: true }),
  ).toHaveCount(0);
  await expect(
    phone.getByRole("heading", { name: "Pain", exact: true }),
  ).toBeVisible();
  await expect(phone.getByRole("searchbox", { name: "Rechercher un élément", exact: true })).toHaveCount(0);
  await phone.getByRole("button", { name: "Rechercher dans la liste", exact: true }).click();
  await phone.getByRole("searchbox", { name: "Rechercher un élément", exact: true }).fill("introuvable");
  await expect(phone.getByRole("heading", { name: "Pain", exact: true })).toHaveCount(0);
  await phone.getByRole("button", { name: "Fermer la recherche", exact: true }).click();
  await expect(phone.getByRole("heading", { name: "Pain", exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await phone.setViewportSize({ width, height: 844 });
    const dimensions = await phone.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      window: innerWidth,
    }));
    if (dimensions.page > dimensions.window + 1)
      throw new Error(
        `Débordement horizontal à ${width}px: ${JSON.stringify(dimensions)}`,
      );
  }
  await optionsAction(page, "Modifier le repas");
  await page.locator("#event-title").fill("Repas renommé");
  await page.getByRole("dialog").getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(
    phone.getByRole("heading", { name: "Repas renommé", exact: true }),
  ).toBeVisible();
  await optionsAction(page, "Modifier le repas");
  await page
    .getByRole("button", { name: "Supprimer le repas", exact: true })
    .click();
  await page.getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(
    page.getByRole("main").getByRole("button", { name: "Nouveau repas", exact: true }),
  ).toBeVisible();
  const list = await admin.request.get(base + "/api/events");
  if ((await list.json()).length !== 0)
    throw new Error("Le repas supprimé subsiste");
  await expect(
    phone.getByRole("heading", {
      name: "Repas introuvable",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const title of ["Repas mobile un", "Repas mobile deux"]) {
    await chooseMeal(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Nouveau repas", exact: true })
      .click();
    await page.locator("#event-title").fill(title);
    await page.locator("#event-date").fill("2026-12-05T20:00");
    await page.getByRole("dialog").getByRole("button", { name: "Créer", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
  await chooseMeal(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Repas mobile un", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Repas mobile un", exact: true }),
  ).toBeVisible();
  await optionsAction(page, "Déconnexion");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openOptions(page);
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Modifier le repas", exact: true }),
  ).toHaveCount(0);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "QA navigateur OK : création admin desktop et mobile, objectifs, ajout libre mobile, détails repliés, édition pour autrui, WS 2 téléphones, filtre manquants, recherche masquable, responsive320–1440, options, renommage, suppression en direct, sélection de repas mobile et déconnexion. Aucune erreur JavaScript.",
  );
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const done = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await done;
  }
  await rm(tmp, { recursive: true, force: true });
}
