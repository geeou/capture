# CAPTURE — Advanced mode: design & module contract

The title screen offers **Partita normale** (classic rules, unchanged) and **Partita avanzata**. Advanced mode adds
nine systems on top of the classic ones. Read `docs/CONTRACT.md` first (classic architecture), then this file.

## Golden rules
1. **Classic matches must stay bit-identical.** `sh tools/classic-check.sh` must print `CLASSIC OK` after your
   changes. Everything new runs only when `game.advanced` is true: classic systems consult `game.hooks`
   (empty in classic matches: `hmul` → exactly 1, `hadd` → exactly 0, `hwhy` → null, `hany` → false), and
   advanced modules live in `src/sim/adv/`. Never branch a classic system on anything but hooks/`game.advanced`,
   never change the order or number of `game.rng()` calls in a classic match.
2. Advanced modules must not consume `game.rng()` in a way that depends on rendering or on the human's UI.
   Deterministic, DOM-free, runs in Node (`npx tsx tools/headless.ts 3000 world 1 adv`).
3. Shared types: `src/sim/adv/types.ts`. Shared numbers: `src/sim/adv/rules.ts` (`ADV`). State and API:
   `game.adv` (`Adv`): `adv.players[id]`, `adv.cmd.*`, `adv.q.*`. Modules talk to each other ONLY through
   `game.adv`, `game.hooks`, `game.cmd/q` and events. Each module overwrites its own slots of `adv.cmd`/`adv.q`
   and writes only its own `AdvPlayer` fields (owner in brackets in types.ts).
4. Performance: the whole `game.step()` in an advanced world match must stay under 4 ms average. Stagger
   per-player work across ticks, use typed arrays, no per-tick full-map scans.
5. Player-facing text is short Italian, sent only to the players concerned (`game.msg(text, level, to, x, y)`).
6. All nine systems apply to bots too, except fog of war (human only). Bots must actually use them (adv/ai.ts).

## The systems

### 1. Fronts (`adv/front.ts`)
- **Focused attack** `adv.cmd.attackAt(attacker, tile, troops)`: attacks the owner of `tile` (0 = free land)
  but only takes tiles within `ADV.focusRadius` of the focus point, with strength ×`focusBonus`
  (×`focusBonusBlitz` with Blitz III). Stored as `attack.ext.focus = {x, y}` (the renderer draws it).
  One attack per (attacker, target) as today: calling `attackAt` again moves the focus and reinforces;
  the classic `cmd.attack` clears the focus (whole border). Needs a border with the target within the radius
  (`adv.q.canAttackAt` gives the reason otherwise).
- **Stance** `adv.cmd.setStance(p, 'offense'|'balanced'|'defense')`: multipliers `ADV.stance[..]` on attack
  strength and on the defence of every owned tile; `stanceCooldown` ticks between changes.

### 2. Capital & supply (`adv/supply.ts`)
- Every player starts with a **capital** at its spawn (`adv.players[id].capital`, a tile; not a Structure).
  Tiles within `capitalRadius` get defence ×`capitalDefense`. When the capital tile changes owner by conquest,
  the loser loses `capitalLossTroops` of its troops, the captor takes `capitalLootGold` of its gold, event
  `capitalLost`, and the capital moves automatically to the loser's largest remaining city (or the owned tile
  nearest its territory centroid). If the tile is nuked, same troop loss, no loot. `adv.cmd.moveCapital`
  relocates it to one of your cities for `capitalMoveCost` gold (event `capitalMoved`).
- **Supply**: hubs = capital, finished cities, finished ports that are not blockaded. `adv.q.supply(p, tile)`
  = 1 within `supplyFull` tiles of the nearest hub, falling linearly to `supplyMin` at `supplyZero`
  (distances ×`blitzSupply` with Blitz II). It multiplies attack strength (hook `attackMul`).
- **Encirclement**: owned tiles not connected by the owner's own land to any hub are *cut*
  (`adv.cut[tile] = 1`, `adv.players[id].cutTiles`). Cut tiles defend at ×`cutDefense`; a pocket cut for
  `cutSurrenderTicks` (×2 with Fortress III) surrenders to the non-allied neighbour with the longest border on
  it (or becomes free land) — event `pocketLost`. Scan each player about every `supplyScanPeriod` ticks,
  staggered. Call `game.markChanged(i)` for tiles whose cut flag changes (the renderer hatches them).
- **Rebellion**: every `rebelPeriod` ticks, a player above `rebelShare` of the land loses a disc (radius 9–15)
  of territory lying more than `rebelDistance` tiles from every hub: it becomes free land (event `rebellion`).

### 3. Economy (`adv/economy.ts`)
- `adv.cmd.setWorkers(p, w)`: gold income ×(0.5 + w), troop growth ×(1.5 − w). Default 0.5 = classic values.
- **Upkeep**: each finished structure beyond the first `upkeepFree` costs `ADV.upkeep[type]` gold per tick
  (hook `goldRateAdd`, exposed as `adv.players[id].upkeep`). Gold never goes below 0; while it is at 0 and
  income is negative, the player's troop growth is halved.

### 4. Strategic resources (`adv/resources.ts`)
- Deposits (oil, iron, uranium) are placed at install time on land, deterministically from the game seed,
  `depositsPer100k` per kind, at least `depositMinDist` apart, not on spawn points. `adv.deposits`,
  `adv.q.depositAt(tile)`, `adv.players[id].res` (counts, kept up to date; event `depositCaptured`).
- Effects: every deposit +`depositGold` gold/tick; iron +`ironAttack` attack each (max `ironMax`);
  oil +1 boat capacity each (max `oilMax`), and with no oil boats sail at ×`noOilBoatSpeed`;
  uranium is required to launch nukes (`ADV.uranium`, hook `forbidNuke`, Italian reason).

### 5. Fleet (`adv/fleet.ts`)
- `adv.cmd.buildWarship(p, portTile)`: a `Unit` of type `'warship'` (`ext.hp`, `ext.maxHp`, `ext.patrol {x,y}`)
  spawned at the port. Cost `warshipCost` +`warshipCostGrowth` per warship owned; capacity
  1 + ports + min(oil, oilMax) up to `warshipCapMax`; needs at least 1 oil.
- Warships patrol around their patrol point (`patrolRadius`), default near their home port;
  `adv.cmd.sendFleet(p, seaTile)` re-bases the nearest free one. Use `game.ext.naval.nav` for routes.
- **Hostile** = not allied, no pact, and either at war (an attack between the two is active or ended less than
  60 s ago) or under embargo by either side. Within `warshipRange` a warship sinks hostile trade ships,
  damages hostile transports (troops lost over a few seconds, then sunk) and fights hostile warships
  (event `warshipSunk`).
- **Blockade**: a port with a hostile warship within `blockadeRadius` and no friendly warship closer is
  blockaded (`adv.q.isBlockaded`, hook `portBlocked`): no trade, and it stops being a supply hub.

### 6. Doctrines (`adv/doctrine.ts`)
- Three branches × three levels (`ADV.doctrineCost`, `doctrineTicks`, cross-branch penalty). One research at a
  time: `adv.cmd.research(p, branch)`, event `doctrineDone`. Effects are listed in `rules.ts`; **the module that
  owns the affected system applies each effect** by reading `doctrineLevel(game, p, branch)`:
  front.ts (blitz 1, 3; fortress 1), supply.ts (blitz 2; fortress 3), doctrine.ts itself through hooks
  (fortress 2 `fortRadiusMul` + `troopCapMul`; projection 1 `boatSpeedMul` + `boatCapAdd`; projection 3
  `nukeCostMul` + `samChanceAdd`), fleet.ts (projection 2).

### 7. Diplomacy (`adv/diplomacy.ts`)
- Offers `adv.cmd.offer(from, to, kind, target?)` / `respondOffer(id, accept)` (event `diploOffer`,
  expire after `offerExpiry`): **nap** (non-aggression pact, `napTicks`), **truce** (ends every active attack
  between the two and forbids new ones for `truceTicks`), **tribute** (`to` becomes the vassal of `from`:
  pays `tributeShare` of its gold income every tick, in exchange the overlord cannot attack it; no expiry,
  either side can break it), **jointWar** (asks an ally or pact partner to attack `target` now).
- Pacts are enforced through hook `forbidAttack` (Italian reason). `adv.cmd.breakPact` ends one with a
  reputation penalty; events `pactFormed` / `pactEnded`.
- **Reputation** (`adv.players[id].reputation`, −100..100): falls when you betray an alliance, break a pact or
  nuke someone you were not at war with; rises slowly when pacts run to their end. Bots weigh it when they
  answer any proposal (including classic alliance requests) and when they pick targets.

### 8. Scenarios & objectives (`adv/scenario.ts`)
- `opts.scenario`: **libero** (classic start), **1939** and **guerrafredda** (world map only: named nations
  from `map.nations` get blocs — pre-made alliances/pacts and wars —, starting bonuses, and for the cold war
  silos and uranium; on other maps fall back to libero). Must work whether or not there is a human.
- **Objectives** for the human only: about every `objectivePeriod` ticks a new timed mission
  (`adv.objectives`, event `objective`): e.g. capture a named deposit, take an enemy capital, reach a land
  share, hold N cities, build a fleet. Reward in gold on completion.

### 9. Fog of war (`adv/fog.ts` + renderer)
- Human only, on unless `opts.fog === false` or there is no human. `adv.fog.visible` is recomputed every
  `fogPeriod` ticks: everything within `visionBorder` tiles of the territory of the human and its allies, plus
  discs around hubs (`ADV.visionHub`) and warships. `seenOwner` remembers the last owner seen.
  Push every tile whose `visible` or `seenOwner` changed onto `fog.changed` for the renderer.
- Outside vision the map shows the remembered owner, dimmed; structures, units, attack fronts, troop numbers,
  nukes in flight and explosions are hidden. A nuke launched at the human from the fog is announced only if a
  finished SAM of the human or an ally covers the target (otherwise it arrives unannounced).
- Bots are not affected by fog.

## Who owns what

| Agent | Classic files (hook plumbing) | Advanced files |
|---|---|---|
| LAND | `src/sim/economy.ts`, `attacks.ts`, `buildings.ts` — hooks `attackMul`, `defenseMul`, `attackTileCost`, `troopCapMul`, `troopRateMul`, `goldRateMul`, `goldRateAdd`, `forbidAttack` (land), `buildCostMul`, `fortRadiusMul` | `adv/front.ts`, `adv/supply.ts`, `adv/economy.ts` |
| SEA | `src/sim/naval.ts`, `nukes.ts` — hooks `boatCapAdd`, `boatSpeedMul`, `portBlocked`, `forbidAttack` (boats, nuke target), `forbidNuke`, `nukeCostMul`, `samChanceAdd` | `adv/resources.ts`, `adv/fleet.ts`, `adv/doctrine.ts` |
| DIPLO | `src/sim/diplomacy.ts`, `ai.ts` | `adv/diplomacy.ts`, `adv/scenario.ts`, `adv/ai.ts` |
| RENDER | `src/render/**` | `adv/fog.ts` |
| UI | `src/ui/**`, `src/main.ts`, `src/style.css`, `src/skins.css`, `src/mobile.css` | — |

Core-owned, read-only for agents: `src/sim/types.ts`, `game.ts`, `index.ts`, `src/sim/adv/types.ts`, `rules.ts`,
`adv/index.ts`, `tools/headless.ts`, `tools/classic-*`, `docs/**`, `package.json`, configs, `index.html`, `public/**`, `pwa/**`.
If the contract lacks something, solve it inside your files (ext bags, events, your own exported helpers) and
say so in your report. Never use git, never run `npm install`. Other agents are editing their own files in
this folder at the same time: `npx tsc --noEmit` may show errors in files you do not own — only yours matter.
Each `adv/*.ts` currently contains a stub `installX(game, opts)`; keep that exported name and signature.

### Render ↔ UI interface
- RENDER extends `Aim` in `src/render/renderer.ts` with `{ kind: 'focus' }` (preview: focus radius ring at the
  cursor), `{ kind: 'fleet' }` (water target marker) and `{ kind: 'capital' }`, and draws, in all four skins:
  capitals, deposits (coloured by owner, kind recognisable), warships (with HP), focus rings of the human's
  focused attacks, the hatch on cut-off tiles, blockaded ports, fog. It exports
  `advGlyphURL(kind: 'oil'|'iron'|'uranium'|'capital'|'warship', color?: string): string` from
  `src/render/icons.ts` for the DOM.
- UI owns every DOM element and input: title buttons, setup (scenario, fog toggle), advanced HUD (resources,
  stance, workers, upkeep, supply/cut warning, objectives, offers inbox, pacts), doctrine panel, context-menu
  entries, touch dock, help. In advanced matches a plain click/tap on enemy or free land is a **focused**
  attack at that tile; "whole front" stays available from the context menu and a toggle.
