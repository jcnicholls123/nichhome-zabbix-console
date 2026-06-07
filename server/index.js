import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp();

app.listen(config.appPort, "0.0.0.0", () => {
  console.log(`NichHome Zabbix Console listening on ${config.appPort}`);
});
