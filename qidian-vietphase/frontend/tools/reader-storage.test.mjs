// Test các hàm thuần của màn đọc (output.jsx): đọc localStorage hỏng, khôi phục vị trí,
// trạng thái tải nội dung. Chạy: node --test qidian-vietphase/frontend/tools/reader-storage.test.mjs
// output.jsx là classic script có JSX, nên chỉ cắt đoạn hàm thuần (không JSX) để chạy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/output.jsx', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('const RD_PREFS_KEY'), source.indexOf('// ── Tiện ích'));
const createReader = (window = {}) => new Function(
  'window',
  pure + '\nreturn { rdSanitizePrefs, rdLoadProgress, rdRestoreTop, rdViewState, rdLoadKey };',
)(window);
const withStored = (stored) => createReader({
  localStorage: { getItem: () => JSON.stringify(stored) },
});

const DEFAULT = { size: 18, lh: 1.9, bg: 'auto' };
// Các giá trị JSON hợp lệ nhưng không phải số: Number() ném lỗi hoặc ép sai kiểu.
const BAD = {
  noValueOf: JSON.parse('{"valueOf":null,"toString":null}'),
  objToString: JSON.parse('{"toString":{}}'),
  array: [18],
  string: '18',
  bool: true,
  nullv: null,
  nested: { size: 18 },
};

for (const [name, bad] of Object.entries(BAD)) {
  for (const field of ['size', 'lh']) {
    test(`Tuỳ chọn hỏng (${name}): ${field} → mặc định, không ném lỗi`, () => {
      const { rdSanitizePrefs } = createReader();
      assert.deepEqual(rdSanitizePrefs({ [field]: bad }), DEFAULT);
    });
  }
  test(`Tuỳ chọn hỏng (${name}): bg → mặc định`, () => {
    const { rdSanitizePrefs } = createReader();
    assert.deepEqual(rdSanitizePrefs({ bg: bad }), DEFAULT);
  });
  test(`Tiến độ hỏng (${name}): num → bỏ tiến độ`, () => {
    assert.equal(withStored({ num: bad, para: 2, frac: 0.5 }).rdLoadProgress('a'), null);
  });
  for (const field of ['para', 'frac', 'pin']) {
    test(`Tiến độ hỏng (${name}): ${field} → 0, giữ chương`, () => {
      const p = withStored({ num: 3, para: 1, frac: 0.5, pin: 0.5, [field]: bad }).rdLoadProgress('a');
      assert.equal(p.num, 3);
      assert.equal(p[field], 0);
    });
  }
  test(`Tiến độ hỏng (${name}): filename → null`, () => {
    if (typeof bad === 'string') return;
    assert.equal(withStored({ num: 3, filename: bad }).rdLoadProgress('a').filename, null);
  });
}

test('Tuỳ chọn hợp lệ được giữ', () => {
  const { rdSanitizePrefs } = createReader();
  assert.deepEqual(rdSanitizePrefs({ size: 22, lh: 1.5, bg: 'sepia' }), { size: 22, lh: 1.5, bg: 'sepia' });
  assert.deepEqual(rdSanitizePrefs({ size: 999, lh: 3, bg: 'x' }), DEFAULT);
  assert.deepEqual(rdSanitizePrefs('rác'), DEFAULT);
  assert.deepEqual(rdSanitizePrefs(null), DEFAULT);
});

test('Tiến độ: gốc JSON không phải object, hoặc getItem ném lỗi → null', () => {
  assert.equal(withStored([1, 2]).rdLoadProgress('a'), null);
  assert.equal(withStored(5).rdLoadProgress('a'), null);
  const r = createReader({ localStorage: { getItem: () => { throw new Error('chặn'); } } });
  assert.equal(r.rdLoadProgress('a'), null);
  const r2 = createReader({ localStorage: { getItem: () => '{hỏng' } });
  assert.equal(r2.rdLoadProgress('a'), null);
});

test('Tiến độ hợp lệ được giữ, kể cả pin trong đoạn', () => {
  const p = withStored({ num: 3, filename: 'f.txt', para: 4, frac: 0.4, pin: 0.75 }).rdLoadProgress('a');
  assert.deepEqual(p, { num: 3, filename: 'f.txt', para: 4, frac: 0.4, pin: 0.75 });
});

// ── Khôi phục vị trí ─────────────────────────────────────────────────────────
test('Khôi phục giữa một đoạn dài: dùng độ lệch trong đoạn, không quay về đầu đoạn', () => {
  const { rdRestoreTop } = createReader();
  // Đoạn 1 cao 3000px bắt đầu ở 500px; đã cuộn tới 60% đoạn.
  const top = rdRestoreTop({ paraTop: 500, paraHeight: 3000, pin: 0.6, frac: 0.3, max: 5000, offset: 72 });
  assert.equal(top, 500 + 1800 - 72);
});

test('Khôi phục khi đang ở đoạn 0 nhưng đã cuộn sâu trong đoạn đó', () => {
  const { rdRestoreTop } = createReader();
  const top = rdRestoreTop({ paraTop: 100, paraHeight: 4000, pin: 0.5, frac: 0.4, max: 3500, offset: 72 });
  assert.equal(top, 100 + 2000 - 72);
});

test('Khôi phục: không tìm thấy đoạn → dùng frac', () => {
  const { rdRestoreTop } = createReader();
  assert.equal(rdRestoreTop({ paraTop: null, paraHeight: 0, pin: 0, frac: 0.5, max: 2000, offset: 72 }), 1000);
});

test('Khôi phục: kẹp trong [0, max]', () => {
  const { rdRestoreTop } = createReader();
  assert.equal(rdRestoreTop({ paraTop: 10, paraHeight: 20, pin: 0, frac: 0, max: 1000, offset: 72 }), 0);
  assert.equal(rdRestoreTop({ paraTop: 900, paraHeight: 400, pin: 1, frac: 0, max: 1000, offset: 72 }), 1000);
});

// ── Trạng thái tải nội dung ──────────────────────────────────────────────────
test('Đổi chương từ chương đã tải: render đầu tiên là loading, không lộ nội dung cũ', () => {
  const { rdViewState, rdLoadKey } = createReader();
  const res = { key: rdLoadKey('c1.txt', 0), content: 'nội dung chương 1', error: null };
  const v = rdViewState('c2.txt', rdLoadKey('c2.txt', 0), res);
  assert.equal(v.phase, 'loading');
  assert.equal(v.content, '');
  assert.equal(v.canExport, false);
});

test('Đổi chương từ chương lỗi: render đầu tiên là loading, không hiện lỗi cũ', () => {
  const { rdViewState, rdLoadKey } = createReader();
  const res = { key: rdLoadKey('c1.txt', 0), content: '', error: { msg: 'x' } };
  const v = rdViewState('c2.txt', rdLoadKey('c2.txt', 0), res);
  assert.equal(v.phase, 'loading');
  assert.equal(v.error, null);
});

test('Thử lại cùng chương: lỗi cũ không còn hiện, chuyển sang loading', () => {
  const { rdViewState, rdLoadKey } = createReader();
  const res = { key: rdLoadKey('c1.txt', 0), content: '', error: { msg: 'x' } };
  const v = rdViewState('c1.txt', rdLoadKey('c1.txt', 1), res);
  assert.equal(v.phase, 'loading');
  assert.equal(v.canExport, false);
});

test('Tải xong nhưng file rỗng: trạng thái riêng, không loading mãi', () => {
  const { rdViewState, rdLoadKey } = createReader();
  for (const content of ['', '   \n\n  ']) {
    const key = rdLoadKey('c1.txt', 0);
    const v = rdViewState('c1.txt', key, { key, content, error: null });
    assert.equal(v.phase, 'empty');
    assert.equal(v.canExport, false);
  }
});

test('Tải xong có nội dung / lỗi đúng chương', () => {
  const { rdViewState, rdLoadKey } = createReader();
  const key = rdLoadKey('c1.txt', 2);
  const ok = rdViewState('c1.txt', key, { key, content: 'a', error: null });
  assert.equal(ok.phase, 'ready');
  assert.equal(ok.content, 'a');
  assert.equal(ok.canExport, true);
  const err = rdViewState('c1.txt', key, { key, content: '', error: { msg: 'x' } });
  assert.equal(err.phase, 'error');
  assert.equal(err.canExport, false);
  assert.equal(rdViewState(null, null, null).phase, 'idle');
});

// ── A → B → A: lượt chọn chương mới không được khớp kết quả cũ của cùng file ────
// Mỗi lượt chọn chương tăng nonce (go() gọi setLoadSeq), nên khoá của lượt quay lại A
// khác khoá của lần tải A trước — nội dung, lỗi và quyền Sao chép/.txt cũ đều bị bỏ.
test('A → B → A (B chậm): không hiện nội dung cũ của A, chưa cho xuất', () => {
  const { rdViewState, rdLoadKey } = createReader();
  let seq = 0;
  const pick = () => ++seq;   // mô phỏng go()
  const a1 = pick();
  const resA = { key: rdLoadKey('A.txt', a1), content: 'nội dung A cũ', error: null };
  assert.equal(rdViewState('A.txt', rdLoadKey('A.txt', a1), resA).phase, 'ready');
  pick();                     // sang B, B chưa trả về
  const a2 = pick();          // quay lại A
  const v = rdViewState('A.txt', rdLoadKey('A.txt', a2), resA);
  assert.equal(v.phase, 'loading');
  assert.equal(v.content, '');
  assert.equal(v.canExport, false);
});

test('A → B → A: lỗi cũ của A không hiện lại trong lúc tải lượt mới', () => {
  const { rdViewState, rdLoadKey } = createReader();
  const errA = { key: rdLoadKey('A.txt', 1), content: '', error: { msg: 'mất mạng', offline: true } };
  const v = rdViewState('A.txt', rdLoadKey('A.txt', 3), errA);
  assert.equal(v.phase, 'loading');
  assert.equal(v.error, null);
  assert.equal(v.canExport, false);
});

test('go() mở lượt tải mới mỗi lần chọn chương (kể cả cùng file)', () => {
  const goBody = source.slice(source.indexOf('const go = useCallbackO('), source.indexOf('// Chọn theo routeChapter'));
  assert.match(goBody, /setLoadSeq\(\s*n\s*=>\s*n\s*\+\s*1\s*\)/);
  assert.match(source, /const loadKey = rdLoadKey\(filename, loadSeq\)/);
  assert.match(source, /\}, \[filename, loadSeq\]\);/);
});
