import type { BrowserContext } from "playwright";

const PLAYWRIGHT_PAGE_COMPAT_INIT_SCRIPT = `
(() => {
  if (typeof globalThis.__name !== "function") {
    Object.defineProperty(globalThis, "__name", {
      configurable: true,
      writable: true,
      value: (target) => target
    });
  }
})();
`;

export async function installPlaywrightPageCompat(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: PLAYWRIGHT_PAGE_COMPAT_INIT_SCRIPT });
}
