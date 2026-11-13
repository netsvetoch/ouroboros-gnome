import Gio from 'gi://Gio';
import { exit } from 'system';

const originalURL = globalThis.URL;
const originalParameters = globalThis.URLSearchParams;
const { componentFieldProblem, componentFieldValue } = await import('../dist-gjs/gjs/component-field-validation.js');
const fixtureFile = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fixtures').get_child('component-address-fields.json');
const [, bytes] = fixtureFile.load_contents(null);
const fixture = JSON.parse(new TextDecoder().decode(bytes));
let failed = 0;
for (const test of fixture.cases) {
  const field = { type: test.type, name: 'test' };
  const valid = componentFieldProblem(field, test.value, 0) === undefined;
  const normalized = componentFieldValue(test.type, test.value);
  if (valid !== test.valid || normalized !== test.normalized) {
    printerr(JSON.stringify({ test, native: { valid, normalized } }));
    failed++;
  }
}
if (globalThis.URL !== originalURL || globalThis.URLSearchParams !== originalParameters) {
  printerr('The field parser replaced a global URL constructor');
  failed++;
}
if (!failed) print(`OK: ${fixture.cases.length} address cases match ${fixture.engine}; global URL constructors unchanged`);
exit(failed ? 1 : 0);
