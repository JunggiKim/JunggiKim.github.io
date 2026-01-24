const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: {
    timeout: 5000,
    toMatchSnapshot: {
      maxDiffPixelRatio: 0.01
    }
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 720 }
  },
  webServer: {
    command: "npx http-server _site -p 4173 -s",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120000
  }
});
