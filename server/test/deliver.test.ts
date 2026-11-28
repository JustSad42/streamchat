import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, MAX_BUFFERED } from '../src/deliver.ts';

const sink = (bufferedAmount: number, readyState = 1) => {
  const log: string[] = [];
  return { log, readyState, OPEN: 1, bufferedAmount, send: (d: string) => log.push(d), terminate: () => log.push('terminated') };
};

test('delivers to a client that keeps up, drops one that does not', () => {
  const ok = sink(0), slow = sink(MAX_BUFFERED + 1), closed = sink(0, 3);
  for (const c of [ok, slow, closed]) deliver(c, 'hi');
  assert.deepEqual(ok.log, ['hi']);
  assert.deepEqual(slow.log, ['terminated']);
  assert.deepEqual(closed.log, []);
});
