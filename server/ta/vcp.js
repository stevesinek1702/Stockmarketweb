/**
 * Volatility Contraction Pattern (Minervini).
 * Detect chuỗi pullback có range (high-low)/high giảm dần + volume giảm.
 *
 * Algo: tìm local maxima trong `lookback` ngày; mỗi cặp max kế tiếp tạo 1 contraction.
 *       Contraction range = (peak_high - trough_low)/peak_high × 100.
 *       VCP nếu: ≥2 contractions, range giảm dần, volume trend giảm, tightness ≤15%.
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} data
 * @param {object} [opts] { lookback=30, minContractions=2 }
 */
function detectVCP({ dates, ohlc, volumes }, opts) {
  const lookback = (opts && opts.lookback) || 30;
  const minContractions = (opts && opts.minContractions) || 2;
  const n = ohlc.length;
  if (n < 4) return { isVCP: false, contractions: [], tightness: 0 }; // cần ≥4 để có ≥2 peaks

  // Lấy cửa sổ lookback ngày cuối (hoặc toàn bộ nếu ngắn hơn)
  const slice = ohlc.slice(-Math.min(lookback, n));
  const vSlice = volumes.slice(-Math.min(lookback, n));

  // Tìm local maxima: high >= lân cận trực tiếp mỗi bên (chấp nhận equal + biên).
  // Linh hoạt hơn "strict > 2 bên" — VCP thực tế peak có thể ở đầu/cuối chuỗi.
  const peaks = [];
  for (let i = 0; i < slice.length; i++) {
    const left1 = i > 0 ? slice[i - 1].h : -Infinity;
    const right1 = i < slice.length - 1 ? slice[i + 1].h : -Infinity;
    if (slice[i].h >= left1 && slice[i].h >= right1) {
      // peak phải khác biệt với lân cận (tránh plateau flat = false peak)
      if (slice[i].h > left1 || slice[i].h > right1) peaks.push(i);
    }
  }
  if (peaks.length < minContractions) return { isVCP: false, contractions: [], tightness: 0 };

  // Mỗi contraction = pullback sau peak[i] cho đến peak[i+1].
  // Range = (peak_high - trough_low_after_peak) / peak_high, trong đó trough_low
  // là low THẤP NHẤT trong khoảng (peak[i], peak[i+1]] — loại trừ chính peak[i]
  // (tránh đo nhầm pullback của wave trước).
  const contractions = [];
  for (let i = 0; i < peaks.length - 1; i++) {
    const seg = slice.slice(peaks[i] + 1, peaks[i + 1] + 1);
    if (seg.length === 0) continue;
    const peakHigh = slice[peaks[i]].h;
    const troughLow = Math.min(...seg.map(x => x.l));
    const rangePct = peakHigh > 0 ? ((peakHigh - troughLow) / peakHigh) * 100 : 0;
    contractions.push({ from: peaks[i], to: peaks[i + 1], rangePct: Math.round(rangePct * 10) / 10 });
  }
  if (contractions.length < minContractions) return { isVCP: false, contractions, tightness: 0 };

  const rangesDecreasing = contractions.every((c, i) => i === 0 || c.rangePct <= contractions[i - 1].rangePct);
  const half = Math.floor(vSlice.length / 2);
  const vFirst = vSlice.slice(0, half).reduce((s, v) => s + v, 0) / Math.max(1, half);
  const vLast = vSlice.slice(half).reduce((s, v) => s + v, 0) / Math.max(1, vSlice.length - half);
  const volumeDeclining = vLast < vFirst * 0.9;
  const tightness = contractions[contractions.length - 1].rangePct;

  return {
    isVCP: rangesDecreasing && volumeDeclining && tightness <= 15,
    contractions,
    tightness
  };
}

module.exports = { detectVCP };
