import { listen } from "@colyseus/tools";
import appConfig from "./app.config.js";

// listen() picks the port from PM2's NODE_APP_INSTANCE on Colyseus Cloud, or
// process.env.PORT, falling back to 2567 for local dev.
const port = Number(process.env.PORT) || 2567;
listen(appConfig, port);
