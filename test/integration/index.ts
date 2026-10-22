import Mocha from 'mocha';
import { defineSuite } from './suite';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  defineSuite();
  return new Promise((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} failed`)) : resolve())));
}
