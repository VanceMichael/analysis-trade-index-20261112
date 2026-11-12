import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('交易原币毛额按数量乘单价，退回数量不充当新价格', () => {

  assert.equal(probe([{quantity: 3, unitPrice: 200, returned: 1}, {quantity: 2, unitPrice: 100, returned: 0}]).gross, 800);
  assert.equal(probe([{quantity: 0, unitPrice: 999}]).gross, 0);
});
