# Rules excerpt: character Energy (synthetic)

```
 1 | // Energy is spent by character actions and refills each turn.
 2 | export const MAX_ENERGY = 10;
 3 |
 4 | export const ACTION_ENERGY_COST = {
 5 |   giveSpeech: 3,
 6 |   holdRally: 4,
 7 |   fundraiser: 4,
 8 |   launchCampaign: 5,
 9 | };
10 |
11 | export const ENERGY_REGEN_PER_TURN = 2;
12 |
13 | export function canPerform(character: Character, action: ActionKey): boolean {
14 |   // Cash does not substitute for Energy.
15 |   return character.energy >= ACTION_ENERGY_COST[action];
16 | }
17 |
18 | export function regenerate(character: Character): number {
19 |   return Math.min(MAX_ENERGY, character.energy + ENERGY_REGEN_PER_TURN);
20 | }
```
