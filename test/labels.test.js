import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, parseLabels } from '../src/extract/labels.js';

test('ontology labels map to the right value kind', () => {
  const cases = [
    ['Hotel Name', 'name', false],
    ['Phone Number', 'phone', false],
    ['Email', 'email', false],
    ['Website', 'url', false],
    ['Description', 'description', false],
    ['Address', 'address', false],
    ['Price', 'price', false],
    ['Main Image', 'image', false],
    ['Gallery Images', 'image_list', true],
    ['Amenities', 'list', true],
    ['Opening Hours', 'hours', false],
    ['Latitude', 'latitude', false],
    ['Longitude', 'longitude', false],
    ['Facebook', 'social', false],
    ['Instagram', 'social', false],
    ['CEO Name', 'name', false],
  ];
  for (const [label, type, plural] of cases) {
    const spec = parseLabel(label);
    assert.equal(spec.type, type, `${label} -> ${spec.type}, expected ${type}`);
    assert.equal(spec.plural, plural, `${label} plural=${spec.plural}, expected ${plural}`);
  }
});

test('label synonyms reach the same spec', () => {
  for (const label of ['Phone', 'Tel', 'Telephone', 'Contact Number', 'Mobile']) {
    assert.equal(parseLabel(label).type, 'phone', label);
  }
  assert.equal(parseLabel('Photos').type, 'image_list');
  assert.equal(parseLabel('Photo Gallery').type, 'image_list');
});

test('unknown labels get a type inferred from their head noun', () => {
  assert.equal(parseLabel('Menu Image').type, 'image');
  assert.equal(parseLabel('Menu Images').type, 'image_list');
  assert.equal(parseLabel('Warranty Period').type, 'date');
  assert.equal(parseLabel('Delivery Fee').type, 'price');
  assert.equal(parseLabel('Support Email').type, 'email');
  assert.equal(parseLabel('Head Chef').type, 'name');
  // Genuinely unknown: treated as free text rather than rejected.
  assert.equal(parseLabel('Flurb Rating Index').type, 'rating');
  assert.equal(parseLabel('Zibble').type, 'text');
});

test('a label carries its own words as search keywords', () => {
  const spec = parseLabel('Menu Image');
  assert.ok(spec.keywords.includes('menu'), 'keeps "menu" so it can find the right picture');
  assert.equal(spec.key, 'menu_image');
});

test('keys are snake_case and duplicates collapse', () => {
  assert.equal(parseLabel('Phone Number').key, 'phone_number');
  assert.equal(parseLabel('  Room   Type  ').key, 'room_type');
  const specs = parseLabels(['Phone Number', 'phone number', '', '   ', 'Email']);
  assert.deepEqual(specs.map((s) => s.key), ['phone_number', 'email']);
});

test('social labels never resolve as a generic website', () => {
  const fb = parseLabel('Facebook Link');
  assert.equal(fb.type, 'social');
  assert.equal(fb.social, 'facebook');
});

test('address is not treated as plural despite the trailing s', () => {
  assert.equal(parseLabel('Address').plural, false);
});
