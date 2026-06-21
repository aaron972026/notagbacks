import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";
import { CONFIG, Phase, Role, HunterMode } from "../shared/config";

/**
 * Authoritative networked state. The server owns every field here; clients only
 * read it. Phase 1 keeps this minimal (just enough to prove sync) — movement,
 * items, lighting and combat fields get added in their respective phases.
 */

export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") role: Role = Role.UNASSIGNED;

  // Position/orientation.
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") ry = 0; // yaw

  @type("boolean") hidden = false; // hiding in a locker — don't render the avatar
  @type("boolean") downed = false; // caught by the Caretaker — spectating
  @type("boolean") light = false; // flashlight currently ON (drives AI detection)
  @type("boolean") escaped = false; // made it out the front doors — survived
}

export class Caretaker extends Schema {
  @type("boolean") active = false; // released (blackout) and hunting
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") ry = 0;
  @type("string") aiState = "idle"; // idle | patrol | investigate | chase | search | attack
}

export class Item extends Schema {
  @type("string") id = "";
  @type("string") kind = ""; // keys | radio | gas_tank | golden_brick | flashlight
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("string") carriedBy = ""; // sessionId of carrier, or "" if on the ground
  @type("boolean") deposited = false; // dropped & locked on the extraction pad
}

export class GameState extends Schema {
  @type("string") code = ""; // short room code players join by
  @type("string") roomName = ""; // optional custom room display name (host-set)
  @type("string") phase: Phase = Phase.LOBBY;
  @type("number") timeLeft = 0; // seconds remaining in the current timed phase
  @type("string") outcome = ""; // "" | "hunter" | "searchers" — set when the round ends
  @type("number") deposited = 0; // required items dropped on the extraction pad
  @type("boolean") doorsOpen = false; // front doors unlocked (all items deposited)
  @type(["string"]) lockedDoors = new ArraySchema<string>(); // doors the Hunter slammed shut
  @type("number") lightsOutFor = 0; // seconds remaining of the Hunter's light sabotage
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Item }) items = new MapSchema<Item>();
  @type(Caretaker) caretaker = new Caretaker();

  // ---- Lobby / roles ----
  @type("string") hostId = ""; // session id of the host (controls settings/start)
  @type("string") hunterMode: HunterMode = HunterMode.ROTATE; // pick | rotate
  @type("boolean") hiddenHunter = true; // conceal the Hunter until blackout
  @type("boolean") traitorMode = false; // one searcher is secretly on the Hunter's side
  @type("boolean") axeThrows = false; // host setting: Hunter can throw axes (50/50, 5s recharge)
  @type("string") pickedHunterId = ""; // chosen hunter when hunterMode = pick
  // Host-adjustable per-game timings (seconds).
  @type("number") hideTime: number = CONFIG.HIDE_PHASE_S;
  @type("number") lightsOnTime: number = CONFIG.LIGHTS_ON_S;
  @type("number") roundTime: number = CONFIG.ROUND_MAX_S;
}
