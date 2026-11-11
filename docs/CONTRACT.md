# CAPTURE — design & module contract

Original real-time territory-conquest game (genre: "territorial .io"). Single player vs bots, in the browser.
Stack: Vite + TypeScript + Canvas 2D, no framework. UI language: **Italian**. Dev server port **5266**.

## The game in one paragraph

A pixel map (each pixel = one tile) of land and water. Every player owns a blob of tiles. Troops grow over
time (faster with more land and cities, capped). You spend a share of your troops to push your border into
unclaimed land or into a neighbour, tile by tile, in real time. Gold comes in over time and buys structures:
cities (more troops), ports (boats, sea trade), forts (defence), factories (gold), missile silos (nukes),
SAM sites (shoot nukes down). Boats carry troops across water for amphibious landings. Nukes erase territory
and troops in a radius and leave fallout. Alliances forbid attacks; breaking one brands you a traitor.
About 88 nation bots and ~150 small tribes share the map. Own **80% of all land** to win. A match should last
roughly 15–25 minutes at 1x speed; the first minutes are a land-grab, the mid game is wars between
neighbours, the late game is navies and nukes.

## Core (already written — read it, do not edit it)

- `src/sim/types.ts` — every shared type, `Commands`, `Queries`, `GameEvent`, `GameOptions`.
- `src/sim/game.ts` — `Game`: grids (`terrain`, `owner`, `fallout`), `players`, `structures`, `units`,
  `attacks`, `setOwner()` (the only way to change ownership; maintains tiles/centroid/border sets/structure
  capture/dirty list), `neighborsOf()`, `addStructure/removeStructure`, `addUnit/removeUnit`, `on/emit/msg`,
  `step()` (runs `systems` in order, then eliminations, unit cleanup, win check), seeded `rng`.
- `src/sim/index.ts` — `createGame(map, opts)`: spawns human/nations/tribes, then calls
  `installEconomy, installAttacks, installBuildings, installNaval, installNukes, installDiplomacy, installAI`.
- `src/sim/testmap.ts` — small test map. `tools/headless.ts` — bot-only match runner (`npx tsx tools/headless.ts 3000 test 1`).

### How a system plugs in

Each system file exports `installX(game: Game): void`. Inside it you
1. push `{ name, tick() }` onto `game.systems` (if you need per-tick work),
2. overwrite your slots in `game.cmd` (commands) and `game.q` (queries),
3. subscribe with `game.on(ev => …)` if you care about events (e.g. clean up on `playerDied`).

Keep private state in closures or in `game.ext.<yourSystem>` / `player.ext.<yourSystem>` / `structure.ext` / `unit.ext`.
All randomness through `game.rng()`. No DOM, no `Math.random`, no `Date.now` in `src/sim` or `src/map` (must run in Node).

### File ownership (one writer per file)

| Files | Owner |
|---|---|
| `src/sim/types.ts`, `game.ts`, `index.ts`, `testmap.ts`, `tools/headless.ts`, `package.json`, configs | core (read-only for agents) |
| `src/sim/economy.ts`, `attacks.ts`, `buildings.ts` | land-war agent |
| `src/map/**` | maps agent |
| `src/sim/naval.ts`, `nukes.ts` | naval/nukes agent |
| `src/sim/diplomacy.ts`, `ai.ts` | diplomacy/AI agent |
| `index.html`, `src/main.ts`, `src/style.css`, `src/render/**`, `src/ui/**` | UI agent |

Other agents are working in this same folder at the same time on their own files. Never edit, format, move or
delete a file you do not own; never run `npm install`/add dependencies; never use git. If the contract seems
to lack something, solve it inside your files (ext bags, events) and mention it in your final report.
`npx tsc --noEmit` may show errors from files other agents are still writing: only errors in *your* files are yours.
You may add your own scripts under `tools/` with a unique prefix (e.g. `tools/naval-test.ts`).

### Cross-module rules everyone relies on

- A player with `alive === false` must never act, be targeted, or keep units/attacks. On `playerDied`, each system
  drops what it tracks for that player. Dead players' tiles are already 0.
- Allies (`game.areAllied(a,b)`) cannot attack, boat-invade or be the *intended* target of a nuke of each other.
  Commands must refuse; the UI shows the Italian reason from the `can*` queries.
- Spending: the system that accepts a command subtracts `player.troops` / `player.gold` itself.
- Structures under construction (`readyTick > game.tick`) give no benefit and cannot fire.
- Fallout (`game.fallout[i] > 0`): much slower / costlier to conquer, decays over time (nukes.ts decays it and
  calls `game.markChanged(i)` when it reaches a visibly different level).
- Player-facing text (`game.msg`, `can*` reasons) is short Italian. Only message the people concerned (`to`),
  keep global spam low: with 240 players the log must stay readable.
- Performance budget: the whole `game.step()` must average < 4 ms on the world map (1600×800, ~240 players).
  Use typed arrays, avoid per-tick allocations and per-tick full-map scans. Stagger expensive work across ticks.

## Reference scale (so separately-written systems agree on numbers)

Sizes: world map 1600 px wide (~400k land tiles); a starting nation is ~80 tiles; a strong mid-game nation
5,000–20,000 tiles; 1% of the world ≈ 4,000 tiles.

| | start | 5,000 tiles | 20,000 tiles |
|---|---|---|---|
| Troop cap (no cities) | ~3,000 (start with 1,200) | ~60,000 | ~180,000 |
| Gold income (no factories) | ~5 /s | ~40 /s | ~120 /s |

Troops regrow from near-empty to ~cap in roughly 60–90 s (fastest around 40% full, slowing near the cap).
Tribes: about 40% of a nation's troop cap/growth for the same land.

Base prices (gold). Structures get +40% per structure of the same type already owned:
city 500 · port 400 · fort 300 · factory 600 · silo 3,000 · sam 1,800 · atom bomb 1,500 per launch · hydrogen bomb 7,000 per launch.
Effects: city +25% troop cap (additive per city) · factory +12 gold/s · port +3 gold/s plus sea trade
(a trade ship pays both ports 40–250 gold by distance) · fort: defence ×2.5 within 12 tiles ·
silo: launches nukes, 15 s reload · sam: 70% to intercept an atom bomb, 35% a hydrogen bomb, within 45 tiles, 12 s reload.
Nukes: atom radius 12 tiles, hydrogen radius 30 tiles; flight ~3 tiles/tick; every tile in the blast becomes
unowned with fallout, structures and boats inside are destroyed, each victim loses troops in proportion to the
land share lost. Transport boats: ~1.2 tiles/tick, no port needed, max 3 at sea per player (+1 per port).

These are starting points: the owner of each system tunes its own numbers, but stay within ~2x of this table.
