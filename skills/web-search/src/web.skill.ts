import "dotenv/config";
import { Type, type Static } from "@sinclair/typebox";
import { WebService } from "./web.service";

// ─── Lazy Singleton ─────────────────────────────────────────────────────────

let webService: WebService | null = null;

function getWebService(): WebService {
  if (!webService) {
    webService = new WebService(process.env.PROXY_URL);
  }
  return webService;
}

// ─── Tool Schemas ───────────────────────────────────────────────────────────

const BrowseWebSchema = Type.Object({
  url: Type.String({ description: "URL to browse" }),
  selector: Type.Optional(Type.String({ description: "CSS selector to narrow extraction" })),
  timeout: Type.Optional(Type.Number({ default: 30000, description: "Navigation timeout in ms" })),
});
type BrowseWebParams = Static<typeof BrowseWebSchema>;

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const tools = [
  {
    name: "browse_web",
    description:
      "Open a URL in headless Chromium and extract page text. Routes through residential proxy if PROXY_URL env is set (needed for geo-restricted content like Polymarket). Optional CSS selector to narrow extraction. Text capped at 50KB.",
    parameters: BrowseWebSchema,
    handler: async (params: BrowseWebParams) => {
      const service = getWebService();
      return service.browse(params.url, {
        selector: params.selector,
        timeout: params.timeout,
      });
    },
  },
];
