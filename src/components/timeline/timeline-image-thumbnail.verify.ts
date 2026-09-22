import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
assert.match(source, /backgroundSize:\s*it\.kind === 'image' \? '100% 100%, auto 100%'/);
assert.match(source, /backgroundRepeat:\s*it\.kind === 'image' \? 'no-repeat, repeat-x'/);

console.log('timeline image thumbnail verification passed');
