import { createApp } from "./app.js";
import { readConfig } from "./config.js";

try {
  const config = readConfig();
  createApp(config).listen(config.port, () => {
    console.log(`Identity Server listening at ${config.issuer}`);
    console.log(`Discovery: ${config.issuer}/.well-known/openid-configuration`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
