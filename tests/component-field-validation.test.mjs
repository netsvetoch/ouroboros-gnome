import assert from 'node:assert/strict';
import test from 'node:test';
import { componentFieldProblem, componentFieldType, componentFieldValue } from '../dist-gjs/gjs/component-field-validation.js';

const valid = (field, value) => assert.equal(componentFieldProblem({ name: 'number', type: 'number', ...field }, value, 0), undefined);
const invalid = (field, value) => assert.equal(typeof componentFieldProblem({ name: 'number', type: 'number', ...field }, value, 0), 'string');

test('number syntax is decimal, finite, and allows exponents', () => {
  for (const value of ['', '0', '-0', '001', '1e2', '1e+2', '-2E3']) valid({}, value);
  for (const value of ['0x10', '0b11', '+1', '1.', '1e', 'NaN', 'Infinity', '1e309', ' 1 ', '1,5']) invalid({}, value);
});

test('step base is min, then initial value, then zero; default step is one', () => {
  valid({ min: .2, default: .1, step: .3 }, '.5');
  invalid({ min: .2, default: .1, step: .3 }, '.4');
  valid({ default: '.2' }, '1.2');
  invalid({ default: '.2' }, '1.3');
  valid({ default: 'not-a-number' }, '2');
  invalid({}, '.5');
  valid({ min: -.25, max: 1.25, step: .5 }, '.75');
  invalid({ min: -.25, max: 1.25, step: .5 }, '.5');
});

test('decimal step arithmetic avoids binary and large-quotient errors', () => {
  for (const value of ['.3', '.30000000000000004', '.30000000001']) valid({ min: 0, step: .1 }, value);
  invalid({ min: 0, step: .1 }, '.30001');
  valid({ step: .1 }, '100000000000000.3');
  invalid({ step: .1 }, '100000000000000.31');
  valid({ min: -1.7e308, step: 1.7e308 }, '1.7e308');
  invalid({ min: -1.7e308, step: 1.7e308 }, '1.6e308');
  valid({ step: 1e-20 }, '1');
});

test('range constraints, required values and card text limits remain enforced', () => {
  valid({ min: 0, max: 2, step: .1 }, '0');
  valid({ min: 0, max: 2, step: .1 }, '2');
  invalid({ min: 0, max: 2, step: .1 }, '-.1');
  invalid({ min: 0, max: 2, step: .1 }, '2.1');
  invalid({ required: true }, '');
  valid({ disabled: true, required: true }, 'not-a-number');
  assert.equal(typeof componentFieldProblem({ type: 'checkbox', required: true }, false, 0), 'string');
  assert.equal(componentFieldProblem({ type: 'checkbox', required: true }, true, 0), undefined);
  assert.equal(componentFieldProblem({}, '🦊'.repeat(4000), 4000), undefined);
  assert.equal(typeof componentFieldProblem({}, '🦊'.repeat(4001), 4000), 'string');
  assert.equal(componentFieldProblem({}, 'x'.repeat(5001), 0), undefined);
});

test('field types follow the closed host vocabulary and normalize case', () => {
  assert.equal(componentFieldType('NUMBER'), 'number');
  assert.equal(componentFieldType('PASSWORD'), 'password');
  assert.equal(componentFieldType('date'), 'text');
  assert.equal(componentFieldType(undefined), 'text');
  valid({ type: 'NUMBER', step: .1 }, '.3');
  invalid({ type: 'NUMBER', step: .1 }, '.35');
});

test('email validation follows the single-address host field', () => {
  for (const value of ['', 'a@b', 'first.last+tag@example.org', '.a..b.@example.org', 'a@xn--e1afmkfd.xn--p1ai']) {
    valid({ type: 'email' }, value);
  }
  for (const value of ['a@', '@host', 'no-at', 'a@-host.org', 'a@host-.org', 'a@host..org', 'a@host.',
    'a@host_name.org', 'a b@example.org', 'a@b,c@d', 'a@пример.рф', 'юзер@example.org', 'a@' + 'a'.repeat(64) + '.org']) {
    invalid({ type: 'email' }, value);
  }
  invalid({ type: 'email', required: true }, ' \t\r\n ');
});

test('URL fields accept absolute WHATWG URLs independently of clickable-link policy', () => {
  for (const value of ['', 'https://example.org/a?x=1#part', 'https://пример.рф/путь', 'https://example.org/a b',
    'http:example.org', 'https:///example.org', 'https://127.1/', 'https://0x7f.1/', 'https://[::1]/',
    'https://user:pass@example.org/a', 'mailto:a@example.org', 'urn:isbn:123', 'custom:', 'custom://',
    'file:///tmp/a', 'data:text/plain,hello', 'javascript:alert(1)']) valid({ type: 'url' }, value);
  for (const value of ['relative/path', 'example.org', '//example.org', 'https://', 'https://#x',
    'https://exa mple.org/', 'https://example.org:65536/', 'https://[bad]/', 'https://999.999/',
    'https://example.123/', 'file://host:22/a']) invalid({ type: 'url' }, value);
});

test('address sanitization is applied to both validation and submitted values', () => {
  assert.equal(componentFieldValue('EMAIL', ' \ta\nb@example.org\r\n '), 'ab@example.org');
  assert.equal(componentFieldValue('url', ' \thttps://exam\nple.org/a\r\n '), 'https://example.org/a');
  assert.equal(componentFieldValue('url', 'https://exam\tple.org/a'), 'https://exam\tple.org/a');
  assert.equal(componentFieldValue('text', ' a\nb '), ' a\nb ');
  assert.equal(componentFieldValue('password', '  test-only  '), '  test-only  ');
  valid({ type: 'email' }, ' \ta\nb@example.org\r\n ');
  valid({ type: 'url' }, ' \thttps://exam\nple.org/a\r\n ');
  invalid({ type: 'url', required: true }, '\t \r\n');
  valid({ type: 'email', disabled: true, required: true }, 'not-an-address');
});
