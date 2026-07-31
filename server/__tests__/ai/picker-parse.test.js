import { describe, it, expect } from 'vitest';
import { parsePickerJSON } from '../../ai.js';

describe('parsePickerJSON', () => {
  it('parse JSON thuần', () => {
    const r = parsePickerJSON('{"picks":[{"symbol":"VCB","rank":1}]}');
    expect(r.picks[0].symbol).toBe('VCB');
  });
  it('parse JSON có markdown code fence', () => {
    const r = parsePickerJSON('```json\n{"picks":[{"symbol":"TCB","rank":1}]}\n```');
    expect(r.picks[0].symbol).toBe('TCB');
  });
  it('parse JSON kèm text thỡ đầu/cuối', () => {
    const r = parsePickerJSON('Đây là kết quả:\n{"picks":[{"symbol":"VHM"}]}\nXong.');
    expect(r.picks[0].symbol).toBe('VHM');
  });
  it('JSON không hợp lệ → null', () => {
    expect(parsePickerJSON('không phải json')).toBeNull();
    expect(parsePickerJSON('')).toBeNull();
    expect(parsePickerJSON(null)).toBeNull();
  });
  it('thiếu picks array → vẫn parse (gọi方 quyết định)', () => {
    const r = parsePickerJSON('{"foo":1}');
    expect(r).not.toBeNull();
    expect(r.foo).toBe(1);
  });
});
