#!/usr/bin/env node
import assert from 'node:assert/strict';
import { __resetAdaptive429StateForTests, clearAdaptive429State, nextAdaptive429CooldownMs } from '../src/reliability/adaptive-429.ts';

const provider = 'state-test-provider';
const credential = 'state-test-key';
const steps = [10, 20, 30, 40, 50, 60, 70, 80];
let now = 1_000;

__resetAdaptive429StateForTests();
for (let stage = 1; stage <= 7; stage++) {
  nextAdaptive429CooldownMs(provider, credential, 0, now, 'still-limited-model', steps);
  now += steps[stage - 1] + 1;
}
nextAdaptive429CooldownMs(provider, credential, 0, now, 'recovered-model', steps);

// A successful unrelated model clears account-level adaptive state in the
// gateway before clearing that model's own state. The limited model's stage
// must remain available for the next account-wide escalation.
clearAdaptive429State(provider, credential);
clearAdaptive429State(provider, credential, 'recovered-model');
assert.equal(
  nextAdaptive429CooldownMs(provider, credential, 0, now + 1, '', steps, 5),
  70,
  'account escalation must inherit the highest still-limited model stage',
);

clearAdaptive429State(provider, credential);
clearAdaptive429State(provider, credential, 'still-limited-model');
assert.equal(
  nextAdaptive429CooldownMs(provider, credential, 0, now + 2, '', steps, 5),
  50,
  'clearing the last limited model must discard its inherited stage',
);

console.log('adaptive 429 cross-model state regression passed');
