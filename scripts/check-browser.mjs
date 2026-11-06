import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  await page
    .getByRole("button", { name: "Options du repas", exact: true })
    .click();
}
async function optionsAction(page, action) {
  await openOptions(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: action, exact: true })
    .click();
}
async function chooseMeal(page) {
  const back = page.getByRole("button", {
    name: "Tous les repas",
    exact: true,
  });
  if (await back.count()) await back.click();
  else if (
    await page
      .getByRole("button", { name: "Options du repas", exact: true })
      .count()
  )
    await optionsAction(page, "Choisir un repas");
  await expect(
    page.getByRole("heading", { name: "Repas", exact: true }),
  ).toBeVisible();
}
async function fillSchedule(page, day, hour, minute) {
  await page.locator("#event-date").fill(day);
  await page.locator("#event-hour").selectOption(hour);
  await page.locator("#event-minute").selectOption(minute);
}
function quantityControl(page, id) {
  return page
    .locator(".quantity-control")
    .filter({ has: page.locator(`#${id}`) });
}
async function checkModalSizing(page) {
  const original = page.viewportSize();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const size = await page
      .getByRole("dialog")
      .evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
    expect(
      size.scroll,
      `Modal horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(size.client + 1);
    const documentSize = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: innerWidth,
    }));
    expect(documentSize.scroll).toBeLessThanOrEqual(documentSize.client + 1);
  }
  await page.setViewportSize(original);
}
async function checkMapsLink(page, address) {
  const link = page.getByRole("link", {
    name: `Ouvrir l’adresse dans Maps : ${address}`,
    exact: true,
  });
  await expect(link).toBeVisible();
  const url = new URL(await link.getAttribute("href"));
  expect(url.hostname).toBe("www.google.com");
  expect(url.pathname).toBe("/maps/search/");
  expect(url.searchParams.get("query")).toBe(address);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
}
async function expandItem(page, name) {
  const summary = page.getByLabel(`Voir les apports pour ${name}`, {
    exact: true,
  });
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
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
    locale: "en-US",
    timezoneId: "Europe/Paris",
  });
  const errors = [];
  const page = await admin.newPage();
  page.on("pageerror", (x) => errors.push(x.message));
  await page.goto(base + "/admin");
  await page.locator("#admin-password").fill(password);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Nouveau repas", exact: true })
    .click();
  await page.locator("#event-title").fill("Repas de vérification");
  await checkModalSizing(page);
  await expect(page.locator("#event-hour option")).toHaveCount(24);
  expect(
    await page
      .locator("#event-hour option")
      .evaluateAll((options) => options.map((option) => option.value)),
  ).toEqual(
    Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  );
  expect(
    await page
      .locator("#event-minute option")
      .evaluateAll((options) =>
        options.map((option) => option.value).filter(Boolean),
      ),
  ).toEqual(["00", "15", "30", "45"]);
  await fillSchedule(page, "2026-11-21", "19", "30");
  await page.locator("#event-location").fill("Chez Anne");
  const address = "10 rue de Rivoli, 75001 Paris";
  await page.locator("#event-address").fill(address);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Créer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Repas de vérification", exact: true }),
  ).toBeVisible();
  const url = page.url();
  const eventToken = url.split("/e/")[1];
  await expect(page.locator(".event-meta")).toContainText("19:30");
  await expect(page.locator(".event-meta")).not.toContainText(/\b(?:AM|PM)\b/);
  await expect(page.locator(".connection")).toHaveCount(0);
  await checkMapsLink(page, address);
  await page.locator(".add-item-end").click();
  await page.locator("#item-name").fill("Fromage");
  await page.getByLabel("Définir un objectif", { exact: false }).check();
  const objective = page.getByRole("spinbutton", {
    name: "Objectif",
    exact: true,
  });
  await objective.fill("1,5");
  await expect(objective).toHaveValue("");
  await objective.fill("1.5");
  await expect(objective).toHaveValue("");
  await quantityControl(page, "item-target")
    .getByRole("button", { name: "Augmenter objectif", exact: true })
    .click();
  await expect(objective).toHaveValue("1");
  await objective.press("ArrowUp");
  await expect(objective).toHaveValue("2");
  await objective.press("ArrowDown");
  await expect(objective).toHaveValue("1");
  await objective.fill("2400");
  await checkModalSizing(page);
  await page.locator("#item-first-quantity").fill("1200");
  await page.locator("#contribution-name").fill("Anne");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Ajouter", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Fromage", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".item-card").filter({
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
  await expect(phone.locator(".connection")).toHaveCount(0);
  await checkMapsLink(phone, address);
  await openOptions(phone);
  await expect(
    phone
      .getByRole("dialog")
      .getByRole("button", { name: "Modifier le repas", exact: true }),
  ).toHaveCount(0);
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "Fermer", exact: true })
    .click();
  await expect(phone.locator(".item-details").first()).not.toHaveAttribute(
    "open",
  );
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
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "Continuer", exact: true })
    .click();
  await checkModalSizing(phone);
  await phone.locator("#contribution-quantity").fill("12,5");
  await expect(phone.locator("#contribution-quantity")).toHaveValue("1200");
  await phone.locator("#contribution-quantity").fill("2640");
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
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
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "Ajouter", exact: true })
    .click();
  const bread = page
    .locator(".item-card")
    .filter({ has: page.getByRole("heading", { name: "Pain", exact: true }) });
  await expect(bread).toBeVisible();
  await expect(bread.locator(".quantity-row")).toHaveText("2 pièces");
  await expect(bread.getByRole("progressbar")).toHaveCount(0);
  await phone.locator(".add-item-end").click();
  await phone.locator("#item-name").fill("Boissons");
  await phone.locator("#item-unit").selectOption("L");
  const litres = phone.locator("#item-first-quantity");
  await litres.fill("1,5");
  await expect(litres).toHaveValue("1,5");
  const litreControl = quantityControl(phone, "item-first-quantity");
  await litreControl
    .getByRole("button", { name: "Augmenter premier apport", exact: true })
    .click();
  await expect(litres).toHaveValue("2,5");
  await litreControl
    .getByRole("button", { name: "Diminuer premier apport", exact: true })
    .click();
  await expect(litres).toHaveValue("1,5");
  await litres.fill("0,5");
  await expect(
    litreControl.getByRole("button", {
      name: "Diminuer premier apport",
      exact: true,
    }),
  ).toBeDisabled();
  await litreControl
    .getByRole("button", { name: "Augmenter premier apport", exact: true })
    .click();
  await expect(litres).toHaveValue("1,5");
  await phone.locator("#contribution-person").selectOption({ label: "Anne" });
  await checkModalSizing(phone);
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "Ajouter", exact: true })
    .click();
  const drinks = phone
    .locator(".item-card")
    .filter({
      has: phone.getByRole("heading", { name: "Boissons", exact: true }),
    });
  await expect(drinks.locator(".quantity-row")).toHaveText("1,5 L");
  const saved = await (
    await guest.request.get(base + "/api/events/" + eventToken)
  ).json();
  const drinkItem = saved.items.find((item) => item.name === "Boissons");
  expect(
    saved.contributions.find((apport) => apport.itemId === drinkItem.id)
      .quantity,
  ).toBe(1.5);

  await expandItem(page, "Pain");
  await page
    .getByRole("button", { name: "Modifier Pain", exact: true })
    .click();
  await page.getByLabel("Définir un objectif", { exact: false }).check();
  await page
    .getByRole("spinbutton", { name: "Objectif", exact: true })
    .fill("3");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  const phoneBread = phone
    .locator(".item-card")
    .filter({ has: phone.getByRole("heading", { name: "Pain", exact: true }) });
  await expect(phoneBread).toContainText("67 %");
  await phone.getByRole("tab", { name: "Personnes", exact: true }).click();
  await expect(
    phone.locator(".person-card").filter({
      has: phone.getByRole("heading", { name: "Anne", exact: true }),
    }),
  ).toContainText("Pain");
  await phone.getByRole("tab", { name: "Liste", exact: true }).click();
  await phone
    .getByRole("button", {
      name: "Afficher les éléments manquants",
      exact: true,
    })
    .click();
  await expect(
    phone.getByRole("button", {
      name: "Afficher les éléments manquants",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    phone.getByRole("heading", { name: "Fromage", exact: true }),
  ).toHaveCount(0);
  await expect(
    phone.getByRole("heading", { name: "Pain", exact: true }),
  ).toBeVisible();
  await expect(
    phone.getByRole("searchbox", {
      name: "Rechercher un élément",
      exact: true,
    }),
  ).toHaveCount(0);
  await phone
    .getByRole("button", { name: "Rechercher dans la liste", exact: true })
    .click();
  await phone
    .getByRole("searchbox", { name: "Rechercher un élément", exact: true })
    .fill("introuvable");
  await expect(
    phone.getByRole("heading", { name: "Pain", exact: true }),
  ).toHaveCount(0);
  await phone
    .getByRole("button", { name: "Fermer la recherche", exact: true })
    .click();
  await expect(
    phone.getByRole("heading", { name: "Pain", exact: true }),
  ).toBeVisible();
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  await expect(
    phone.getByRole("heading", { name: "Repas renommé", exact: true }),
  ).toBeVisible();
  const legacySnapshot = await (
    await admin.request.get(base + "/api/events/" + eventToken)
  ).json();
  const legacy = new DatabaseSync(join(tmp, "db.sqlite"));
  legacy
    .prepare("UPDATE events SET date=? WHERE id=?")
    .run("2026-11-21T19:10", legacySnapshot.event.id);
  legacy.close();
  await page.reload();
  await optionsAction(page, "Modifier le repas");
  await page.locator("#event-title").fill("Ancien horaire conservé");
  await expect(page.locator("#event-minute")).toHaveValue("");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  const unchangedSchedule = await (
    await admin.request.get(base + "/api/events/" + eventToken)
  ).json();
  expect(unchangedSchedule.event.date).toBe("2026-11-21T19:10");
  expect(unchangedSchedule.event.address).toBe(address);
  await optionsAction(page, "Modifier le repas");
  await page.locator("#event-minute").selectOption("45");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  await expect(phone.locator(".event-meta")).toContainText("19:45");
  await checkMapsLink(phone, address);
  await optionsAction(page, "Modifier le repas");
  await page
    .getByRole("button", { name: "Supprimer le repas", exact: true })
    .click();
  await page.getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByRole("button", { name: "Nouveau repas", exact: true }),
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
      .getByRole("main")
      .getByRole("button", { name: "Nouveau repas", exact: true })
      .click();
    await page.locator("#event-title").fill(title);
    await fillSchedule(page, "2026-12-05", "20", "00");
    await checkModalSizing(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Créer", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
  await chooseMeal(page);
  await page
    .getByRole("button", {
      name: "Modifier le repas Repas mobile un",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Archiver ce repas", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Ouvrir le repas Repas mobile un",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Archives/ }).click();
  await page
    .getByRole("button", {
      name: "Ouvrir le repas Repas mobile un",
      exact: true,
    })
    .click();
  await optionsAction(page, "Modifier le repas");
  await page
    .getByRole("button", { name: "Réactiver ce repas", exact: true })
    .click();
  await chooseMeal(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Repas", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Ouvrir le repas Repas mobile un",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Repas mobile un", exact: true }),
  ).toBeVisible();
  await optionsAction(page, "Déconnexion");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openOptions(page);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Modifier le repas", exact: true }),
  ).toHaveCount(0);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "QA navigateur OK : admin desktop/mobile, horaires 24 h par quarts d’heure, adresse Maps, quantités entières et litres décimaux avec pas de 1, formulaires320–390 et liste320–1440 sans débordement, héritage des horaires, WS2clients, filtres, archives, suppression et déconnexion. Aucune erreur JavaScript.",
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
