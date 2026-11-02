require("dotenv").config({ quiet: true });
const config = require("./config");
const { createStore } = require("./store");
const { createGeminiClient } = require("./ai/gemini");
const { createApp } = require("./app");

async function main() {
  const store = await createStore({ mongoUri: config.mongoUri });
  const ai = createGeminiClient({ apiKey: config.geminiApiKey, model: config.geminiModel });
  const app = createApp({ store, ai, config });

  const server = app.listen(config.port, () => {
    console.log(`AI Code Editor API on port ${config.port} (storage: ${store.kind}, AI: ${ai ? config.geminiModel : "off"})`);
    if (!ai) console.warn("GEMINI_API_KEY is not set: AI features will return 503.");
    if (!config.corsOrigins.length) console.warn("CORS_ORIGINS is not set: any website can call this API (fine for local dev).");
  });

  const shutdown = () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
