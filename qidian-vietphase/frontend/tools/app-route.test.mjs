// Test parseHash/buildHash của app.jsx: đoạn hash mã hoá sai không được ném lỗi.
// Chạy: node --test qidian-vietphase/frontend/tools/app-route.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/app.jsx', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('const VALID_TABS'), source.indexOf('// Kiểu chữ đọc lưu riêng'));
const withHash = (hash) => new Function('location', pure + '\nreturn { parseHash, buildHash };')({ hash });

test('Hash hợp lệ: màn đọc không mở đối chiếu', () => {
  assert.deepEqual(withHash('#/truyen-a/output/3').parseHash(),
    { slug: 'truyen-a', tab: 'output', readerChapter: '3', chapter: null });
  assert.deepEqual(withHash('#/truyen-a/output/3/doi-chieu').parseHash(),
    { slug: 'truyen-a', tab: 'output', readerChapter: '3', chapter: '3' });
  assert.deepEqual(withHash('#/truyen-a/chapters/3').parseHash(),
    { slug: 'truyen-a', tab: 'chapters', readerChapter: null, chapter: '3' });
  assert.deepEqual(withHash('#/truyen-a/output').parseHash(),
    { slug: 'truyen-a', tab: 'output', readerChapter: null, chapter: null });
});

for (const [name, hash] of [
  ['số chương', '#/truyen-a/output/%E0%A4%A'],
  ['số chương (%)', '#/truyen-a/output/%'],
  ['slug', '#/%E0%A4%A/output/3'],
  ['slug (%zz)', '#/%zz/chapters'],
  ['đối chiếu', '#/truyen-a/chapters/%C0'],
]) {
  test(`Hash mã hoá sai (${name}): không ném lỗi, bỏ đoạn hỏng`, () => {
    const r = withHash(hash).parseHash();
    assert.ok(r && typeof r === 'object');
  });
}

test('Hash mã hoá sai: đoạn hỏng thành null, đoạn còn lại giữ', () => {
  assert.equal(withHash('#/truyen-a/output/%E0%A4%A').parseHash().readerChapter, null);
  assert.equal(withHash('#/truyen-a/output/%E0%A4%A').parseHash().slug, 'truyen-a');
  assert.equal(withHash('#/%zz/output/3').parseHash().slug, null);
});
