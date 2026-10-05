const test = require('node:test');
const assert = require('node:assert');
const { capHashtags } = require('../src/services/captionService');

test('capHashtags keeps only the first N tags', () => {
  const out = capHashtags('lol 😭\n#a #b #c #d #e #f #g\nFollow for more', 5);
  assert.strictEqual(out, 'lol 😭\n#a #b #c #d #e\nFollow for more');
});
