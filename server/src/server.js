import { createApp } from "./app.js";
import { config } from "./config.js";
import { enabledProviders } from "./providers/index.js";

if (config.problems.length) {
  console.error("Fix the setup problems above, then start again.");
  process.exit(1);
}

const app = createApp();

app.listen(config.port, () => {
  const providers = enabledProviders();
  console.log(`Football Predictions running at ${config.appUrl || `http://localhost:${config.port}`}`);
  console.log(`Payment providers: ${providers.length ? providers.join(", ") : "none - add keys to server/.env"}`);
});
