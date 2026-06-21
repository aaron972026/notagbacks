import config from "@colyseus/tools";
import { BlackoutRoom } from "./rooms/BlackoutRoom.js";

/**
 * Colyseus Cloud entry point. Using @colyseus/tools lets Cloud manage the
 * process (NGINX + PM2) and assign each instance its own port via .listen().
 * Local dev still works the same — `npm run dev` runs this through tsx.
 */
export default config({
  initializeGameServer: (gameServer) => {
    // filterBy(["code"]) groups only clients sharing the same room code —
    // the basis for "join by short code".
    gameServer.define("blackout", BlackoutRoom).filterBy(["code"]);
  },

  initializeExpress: (app) => {
    // Health check for Cloud / uptime monitors.
    app.get("/health", (_req, res) => {
      res.json({ ok: true, game: "blackout" });
    });
  },
});
