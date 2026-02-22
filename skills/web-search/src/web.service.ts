import type { Browser } from "puppeteer";
import { BrowseResult } from "./types";

const MAX_TEXT_LENGTH = 50_000; // 50KB cap to avoid blowing up agent context

export class WebService {
  private proxyUrl?: string;

  constructor(proxyUrl?: string) {
    this.proxyUrl = proxyUrl;
  }

  async browse(
    url: string,
    options: { selector?: string; timeout?: number } = {},
  ): Promise<BrowseResult> {
    const { selector, timeout = 30000 } = options;

    // Dynamic import — puppeteer is optional and heavy
    const puppeteer = await import("puppeteer");

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ];

    // Parse proxy URL and add to launch args
    let proxyUsername: string | undefined;
    let proxyPassword: string | undefined;

    if (this.proxyUrl) {
      try {
        const parsed = new URL(this.proxyUrl);
        proxyUsername = parsed.username || undefined;
        proxyPassword = parsed.password || undefined;
        // Chromium needs host:port without auth
        launchArgs.push(`--proxy-server=${parsed.hostname}:${parsed.port}`);
      } catch {
        // Invalid proxy URL — launch without proxy
      }
    }

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: launchArgs,
      });

      const page = await browser.newPage();

      // Authenticate with proxy if credentials provided
      if (proxyUsername && proxyPassword) {
        await page.authenticate({
          username: decodeURIComponent(proxyUsername),
          password: decodeURIComponent(proxyPassword),
        });
      }

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );

      // Try networkidle2 first for SPA content, fall back to domcontentloaded
      try {
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: Math.min(timeout, 15000),
        });
      } catch {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
      }

      const title = await page.title();

      let text: string;
      if (selector) {
        text = await page.$eval(selector, (el) => (el as HTMLElement).innerText).catch(
          () => `Selector "${selector}" not found on page`,
        );
      } else {
        text = await page.evaluate(() => {
          // Remove script/style/nav/header/footer to get article content
          const remove = document.querySelectorAll(
            "script, style, nav, header, footer, iframe, noscript",
          );
          remove.forEach((el) => el.remove());
          return document.body?.innerText || "";
        });
      }

      // Truncate to cap
      const fullLength = text.length;
      if (text.length > MAX_TEXT_LENGTH) {
        text = text.slice(0, MAX_TEXT_LENGTH) + "\n\n[...truncated at 50KB]";
      }

      return {
        title,
        url,
        text,
        extractedAt: new Date().toISOString(),
        contentLength: fullLength,
        ...(selector ? { selector } : {}),
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}
