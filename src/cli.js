import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { loadPolicy } from './policy.js';
import { buildIndex } from './index.js';
import { renderReview } from './report.js';
import { writeResult } from './output.js';

const COMMANDS = ['summary', 'inspect', 'index', 'review'];
const OPTIONS = ['--input', '--out', '--policy', '--fx', '--from', '--to'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')}`);
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error('参数应为 --input/--out/--policy/--fx/--from/--to 加对应值');
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  for (const key of ['from', 'to']) {
    if (result[key] !== undefined) {
      const period = Number(result[key]);
      if (!Number.isSafeInteger(period)) throw new Error('期间应为整数');
      result[key] = period;
    }
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let result;
  if (options.command === 'summary') {
    result = summarize(dataset.records);
  } else if (options.command === 'inspect') {
    result = { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  } else {
    const policy = await loadPolicy(options.policy ?? 'data/policy.json');
    const built = buildIndex(dataset.records, policy, { fx: options.fx, from: options.from, to: options.to });
    result = options.command === 'review'
      ? { review: renderReview(built), caliber: built.caliber, range: built.range }
      : built;
  }
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(typeof result.review === 'string'
      ? result.review + '\n'
      : JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
