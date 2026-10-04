import { createApp } from "./app.js";
import { config } from "./config.js";
import { enabledProviders } from "./providers/index.js";

const app = createApp();

app.listen(config.port, () => {
  const providers = enabledProviders();
  console.log(`Football Predictions running at ${config.appUrl} (port ${config.port})`);
  console.log(`Payment providers: ${providers.length ? providers.join(", ") : "none - add keys to server/.env"}`);
});
