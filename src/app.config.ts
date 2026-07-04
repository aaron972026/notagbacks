import config from "@colyseus/tools";
import { matchMaker } from "colyseus";
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

    // Public lobby browser: rooms whose host flipped "Public", still joinable
    // (lobby/campfire — onJoin rejects live phases anyway). Metadata is synced
    // by BlackoutRoom (code/name/phase/player count).
    app.get("/lobbies", async (_req, res) => {
      try {
        const rooms = await matchMaker.query({ name: "blackout" });
        res.json(
          rooms
            .filter(
              (r) =>
                r.metadata?.public === true &&
                !r.locked &&
                (r.metadata?.phase === "lobby" || r.metadata?.phase === "campfire"),
            )
            .map((r) => ({
              roomId: r.roomId,
              code: r.metadata?.code ?? "",
              name: r.metadata?.name ?? "",
              players: r.clients,
              maxPlayers: r.maxClients,
              phase: r.metadata?.phase ?? "lobby",
            })),
        );
      } catch {
        res.status(500).json([]);
      }
    });

    // Resolve a short room code (public OR private) to a joinable roomId, so
    // the client can joinById — a typo'd code becomes "room not found" instead
    // of silently creating a fresh empty room.
    app.get("/room-by-code", async (req, res) => {
      try {
        const code = String(req.query.code ?? "").toUpperCase();
        if (!/^[A-Z0-9]{3,6}$/.test(code)) {
          res.status(400).json({ error: "bad code" });
          return;
        }
        const rooms = await matchMaker.query({ name: "blackout" });
        const room = rooms.find((r) => r.metadata?.code === code);
        if (!room) {
          res.status(404).json({ error: "not found" });
          return;
        }
        res.json({ roomId: room.roomId });
      } catch {
        res.status(500).json({ error: "query failed" });
      }
    });
  },
});
