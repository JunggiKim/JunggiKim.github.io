const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("theme-preference", "light");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test("theme toggle updates data-theme and icon", async ({ page }) => {
  const toggle = page.locator(".theme-toggle");
  const icon = page.locator("#theme-toggle-icon");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(icon).toHaveClass(/fa-moon/);

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(icon).toHaveClass(/fa-sun/);

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(icon).toHaveClass(/fa-moon/);
});

test("theme toggle has no focus outline and transparent background", async ({ page }) => {
  const toggle = page.locator(".theme-toggle");

  await toggle.focus();

  const styles = await toggle.evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
      boxShadow: computed.boxShadow,
      backgroundColor: computed.backgroundColor,
      borderStyle: computed.borderStyle
    };
  });

  expect(["none", "auto"]).toContain(styles.outlineStyle);
  expect(styles.outlineWidth).toBe("0px");
  expect(styles.boxShadow).toBe("none");
  expect(styles.borderStyle).toBe("none");
  expect(styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

test("masthead snapshots", async ({ page }) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `
  });

  const masthead = page.locator(".masthead");
  await expect(masthead).toHaveScreenshot("masthead-light.png");

  await page.click(".theme-toggle");
  await expect(masthead).toHaveScreenshot("masthead-dark.png");
});
