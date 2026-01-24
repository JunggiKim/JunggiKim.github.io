# Theme Toggle TDD Checklist

Manual checks (run in a browser):
- Load the home page with no stored preference; confirm theme matches system.
- Click the theme toggle once; confirm `data-theme` changes to `dark` and icon switches to sun.
- Click again; confirm `data-theme` returns to `light` and icon switches to moon.
- Focus the theme toggle (mouse click and keyboard tab); confirm no outline ring appears.
- Verify the toggle button background is transparent and matches the nav background in light/dark.

Automated checks (Playwright):
- `tests/theme-toggle.spec.js` verifies the theme attribute, icon class, focus outline, and snapshots.
