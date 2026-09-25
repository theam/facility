import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceAfterDiscount } from '../src/price.mjs';

test('a 10% discount on 100 yields 90', () => {
  assert.equal(priceAfterDiscount(100, 0.1), 90);
});
