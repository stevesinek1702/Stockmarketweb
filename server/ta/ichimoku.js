/**
 * ICHIMOKU KINKO HYO — tính các đường + interpret chuyên gia.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ĐÓNG VAI TRÒ CAO THỦ ICHIMOKU — ghi nhớ công thức + cách đọc:
 *
 * Ichimoku = "Biểu đồ cân bằng" — 1 bộ chỉ báo đầy đủ: xu hướng + động lượng +
 * support/resistance + tín hiệu entry/exit. Gồm 5 thành phần chính:
 *
 * 1) Tenkan-sen (Conversion Line): (highest-high + lowest-low)/2 trong N phiên.
 *    N Nhật = 9 (chuẩn Goichi Hosoda). Đường "nhanh" — phản ứng giá gần nhất.
 *    = trung bình của điểm cân bằng cung-cầu trong ngắn hạn.
 *
 * 2) Kijun-sen (Base Line): cùng công thức, period dài hơn (26 chuẩn).
 *    Đường "chậm" — xương sống của xu hướng. Dùng làm support/resistance chính,
 *    trailing stop, và tín hiệu khi Tenkan cắt Kijun.
 *
 *    TENKAN & KIJUN CÙNG CÔNG THỨC, KHÁC NHAU Ở PERIOD — đúng như user nói.
 *
 * 3) Senkou Span A: (Tenkan + Kijun)/2, DỊCH TRƯỚC 26 phiên (vẽ trước tương lai).
 * 4) Senkou Span B: (highest-high + lowest-low)/2 trong 52 phiên, dịch trước 26.
 *    Khoảng giữa A và B = KUMO (đám mây) = vùng support/resistance động.
 *      Span A > Span B → mây XANH (Bullish)
 *      Span A < Span B → mây ĐỎ (Bearish)
 *
 * 5) Chikou Span (Lagging Line): close HIỆN TẠI dịch LÙI 26 phiên ra quá khứ.
 *    Nếu Chikou > giá quá khứ → momentum Bullish; < → Bearish.
 *
 * 3 TÍN HIỆU CHÍNH:
 * - TK Cross: Tenkan cắt Kijun lên → Bullish, cắt xuống → Bearish (entry).
 * - Price vs Kumo: giá trên mây → xu hướng tăng; dưới mây → giảm; trong mây → đi ngang.
 * - Chikou vs Price: Chikou tự do (không bị giá cản) → xác nhận xu hướng.
 *
 * Khi chỉ có closes (breadth trên 1576 mã, không có high/low thật): dùng proxy
 * highest-close/lowest-close thay cho high/low. Hợp lý cho breadth, sai số nhỏ.
 * Khi xem 1 mã riêng → luôn dùng high/low thật (qua OHLCV fetch).
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Tính highest-high và lowest-low (hoặc proxy close) trong cửa sổ trượt.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number} period
 * @returns {{highArr:(number|null)[], lowArr:(number|null)[]}} mảng cùng độ dài
 */
function donchian(highs, lows, period) {
  const n = highs.length;
  const highArr = new Array(n).fill(null);
  const lowArr = new Array(n).fill(null);
  if (period <= 0 || n < period) return { highArr, lowArr };
  // Trượt cửa sổ [i-period+1 .. i], dùng deque không tối ưu vì period nhỏ;
  // với period tới 234 + 1576 mã, dùng prefix không áp dụng được cho max/min.
  // Thuật toán monotonic deque O(n) để đảm bảo nhanh với period lớn.
  const dqH = []; // indices, giá trị giảm dần (front = max)
  const dqL = []; // indices, giá trị tăng dần (front = min)
  for (let i = 0; i < n; i++) {
    // high deque
    while (dqH.length && highs[dqH[dqH.length - 1]] <= highs[i]) dqH.pop();
    dqH.push(i);
    while (dqH[0] <= i - period) dqH.shift();
    // low deque
    while (dqL.length && lows[dqL[dqL.length - 1]] >= lows[i]) dqL.pop();
    dqL.push(i);
    while (dqL[0] <= i - period) dqL.shift();
    if (i >= period - 1) {
      highArr[i] = highs[dqH[0]];
      lowArr[i] = lows[dqL[0]];
    }
  }
  return { highArr, lowArr };
}

/**
 * Tenkan-sen (hoặc Kijun-sen — chỉ khác period): (highest+lowest)/2.
 * @param {number[]} highs chuỗi high (hoặc closes nếu proxy breadth)
 * @param {number[]} lows  chuỗi low  (hoặc closes nếu proxy breadth)
 * @param {number} period  9 (Tenkan) | 26 (Kijun) | bất kỳ user đặt
 * @returns {(number|null)[]} mảng cùng độ dài, null trước khi đủ period
 */
function tenkanSen(highs, lows, period) {
  const { highArr, lowArr } = donchian(highs, lows, period);
  return highs.map((_, i) =>
    (highArr[i] != null && lowArr[i] != null) ? (highArr[i] + lowArr[i]) / 2 : null
  );
}

// Alias: Kijun = Tenkan với period khác. Cùng công thức.
const kijunSen = tenkanSen;

/**
 * Senkou Span A = (Tenkan + Kijun)/2, dịch TRƯỚC `displacement` phiên.
 * Trả mảng độ dài n; giá trị tại i được vẽ tại i+displacement.
 * @param {number[]} tenkan
 * @param {number[]} kijun
 * @param {number} displacement số phiên dịch trước (26 chuẩn)
 * @returns {(number|null)[]}
 */
function senkouSpanA(tenkan, kijun, displacement) {
  const n = tenkan.length;
  const span = new Array(n + displacement).fill(null);
  for (let i = 0; i < n; i++) {
    if (tenkan[i] != null && kijun[i] != null) {
      span[i + displacement] = (tenkan[i] + kijun[i]) / 2;
    }
  }
  return span;
}

/**
 * Senkou Span B = (highest+lowest)/2 trong period dài (52 chuẩn), dịch trước.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number} period 52 chuẩn
 * @param {number} displacement 26 chuẩn
 * @returns {(number|null)[]}
 */
function senkouSpanB(highs, lows, period, displacement) {
  const { highArr, lowArr } = donchian(highs, lows, period);
  const n = highs.length;
  const span = new Array(n + displacement).fill(null);
  for (let i = 0; i < n; i++) {
    if (highArr[i] != null && lowArr[i] != null) {
      span[i + displacement] = (highArr[i] + lowArr[i]) / 2;
    }
  }
  return span;
}

/**
 * Chikou Span = close hiện tại dịch LÙI về quá khứ `displacement` phiên.
 * @param {number[]} closes
 * @param {number} displacement
 * @returns {(number|null)[]}
 */
function chikouSpan(closes, displacement) {
  const n = closes.length;
  const span = new Array(n).fill(null);
  for (let i = 0; i + displacement < n; i++) {
    span[i] = closes[i + displacement];
  }
  return span;
}

/**
 * Tính trọn bộ Ichimoku cho 1 chuỗi OHLC (dùng cho chart 1 mã).
 * Trả các chuỗi để vẽ + giá trị hiện tại + trạng thái mây.
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes?:number[]}} history
 * @param {Object} opts { tenkan=9, kijun=26, senkouB=52, displacement=26 }
 * @returns {null|{dates, close, tenkan, kijun, spanA, spanB, chikou, kumo:{now, state, top, bottom}}}
 */
function computeIchimoku(history, opts = {}) {
  const ohlc = history.ohlc || [];
  if (ohlc.length < 30) return null;
  const tenkanP = +opts.tenkan || 9;
  const kijunP = +opts.kijun || 26;
  const senkouBP = +opts.senkouB || 52;
  const disp = +opts.displacement || 26;

  const highs = ohlc.map(x => x.h);
  const lows = ohlc.map(x => x.l);
  const closes = ohlc.map(x => x.c);

  const tenkan = tenkanSen(highs, lows, tenkanP);
  const kijun = kijunSen(highs, lows, kijunP);
  const spanA = senkouSpanA(tenkan, kijun, disp);
  const spanB = senkouSpanB(highs, lows, senkouBP, disp);
  const chikou = chikouSpan(closes, disp);

  const i = closes.length - 1;
  // Mây "hiện tại" = giá trị Kumo tại phiên hiện tại (đã được dịch trước từ quá khứ).
  // Span A/B được vẽ trước `displacement` phiên, nên tại i cần dữ liệu từ i-displacement.
  // Nếu chưa đủ (data ngắn) → fallback lấy mây tại phiên gần nhất có giá trị hợp lệ.
  let saNow = spanA[i] != null ? spanA[i] : null;
  let sbNow = spanB[i] != null ? spanB[i] : null;
  if (saNow == null || sbNow == null) {
    // Quét lùi từ cuối để tìm phiên có cả 2 giá trị mây (mây quá khứ vẫn còn ý nghĩa S/R gần)
    for (let j = i; j >= 0; j--) {
      if (spanA[j] != null && spanB[j] != null) { saNow = spanA[j]; sbNow = spanB[j]; break; }
    }
  }
  const kumoState = (saNow != null && sbNow != null)
    ? (saNow > sbNow ? 'green' : (saNow < sbNow ? 'red' : 'flat'))
    : 'unknown';
  const kumoTop = (saNow != null && sbNow != null) ? Math.max(saNow, sbNow) : null;
  const kumoBottom = (saNow != null && sbNow != null) ? Math.min(saNow, sbNow) : null;

  return {
    dates: history.dates || [],
    close: closes[i],
    tenkan: tenkan[i], kijun: kijun[i],
    spanA: saNow, spanB: sbNow, chikou: chikou[i] != null ? chikou[i] : null,
    series: { tenkan, kijun, spanA, spanB, chikou, closes },
    kumo: { now: saNow, state: kumoState, top: kumoTop, bottom: kumoBottom }
  };
}

// ═══════════════════════════════════════════════════════════════════════
// INTERPRET ENGINE — đóng vai cao thủ Ichimoku đọc tín hiệu + gợi ý dùng
// ═══════════════════════════════════════════════════════════════════════

/**
 * Đọc trạng thái Ichimoku tại phiên hiện tại → verdict + giải thích + gợi ý hành động.
 * @param {Object} ic kết quả computeIchimoku (cần close, tenkan, kijun, kumo)
 * @returns {{score:number, verdict:string, signals:string[], advice:string[], education:string[]}}
 *   score 0-100 (cao = bullish mạnh), verdict: 'Strong Bull'|'Bull'|'Neutral'|'Bear'|'Strong Bear'
 */
function interpretIchimoku(ic) {
  const signals = [];
  const advice = [];
  const education = [];
  let score = 50; // khởi điểm trung tính

  if (!ic || ic.tenkan == null || ic.kijun == null) {
    return { score: 50, verdict: 'Chưa đủ data', signals: ['Chưa đủ lịch sử để tính Ichimoku.'], advice: [], education: [] };
  }

  const { close, tenkan, kijun, kumo } = ic;

  // 1) TENKAN vs KIJUN (TK Cross) — tín hiệu động lượng ngắn hạn
  if (tenkan > kijun) {
    score += 18;
    signals.push(`✅ Tenkan (${tenkan.toFixed(2)}) > Kijun (${kijun.toFixed(2)}) — TK Cross BULLISH (động lượng ngắn hạn tăng).`);
  } else if (tenkan < kijun) {
    score -= 18;
    signals.push(`🔻 Tenkan (${tenkan.toFixed(2)}) < Kijun (${kijun.toFixed(2)}) — TK Cross BEARISH (động lượng ngắn hạn giảm).`);
  } else {
    signals.push(`➖ Tenkan = Kijun — động lượng trung tính, chờ phá vỡ.`);
  }
  education.push('**Tenkan/Kijun Cross**: Khi đường nhanh (Tenkan) cắt LÊN đường chậm (Kijun) = tín hiệu mua; cắt XUỐNG = tín hiệu bán. Đây là tín hiệu entry phổ biến nhất của Ichimoku.');

  // 2) GIÁ vs KUMO (đám mây) — xu hướng chính
  if (kumo.top != null && kumo.bottom != null) {
    if (close > kumo.top) {
      score += 22;
      signals.push(`✅ Giá (${close.toFixed(2)} đang TRÊN mây Kumo (đỉnh mây ${kumo.top.toFixed(2)}) — xu hướng TĂNG rõ ràng.`);
    } else if (close < kumo.bottom) {
      score -= 22;
      signals.push(`🔻 Giá (${close.toFixed(2)}) đang DƯỚI mây Kumo (đáy mây ${kumo.bottom.toFixed(2)}) — xu hướng GIẢM rõ ràng.`);
    } else {
      signals.push(`➖ Giá đang TRONG mây Kumo (${kumo.bottom.toFixed(2)}–${kumo.top.toFixed(2)}) — thị trường ĐI NGANG, chờ xác nhận.`);
    }
  }
  education.push('**Giá vs Kumo**: Đám mây (Kumo) là support/resistance động. Giá TRÊN mây = xu hướng tăng, DƯỚI mây = xu hướng giảm, TRONG mây = đi ngang. Chỉ nên trade cùng chiều khi giá đã thoát khỏi mây.');

  // 3) MÀU MÂY (Span A vs Span B)
  if (kumo.state === 'green') {
    score += 8;
    signals.push(`✅ Mây Kumo XANH (Span A > Span B) — mây hỗ trợ xu hướng tăng.`);
  } else if (kumo.state === 'red') {
    score -= 8;
    signals.push(`🔻 Mây Kumo ĐỎ (Span A < Span B) — mây kháng cự, xu hướng giảm.`);
  }
  education.push('**Màu mây**: Span A (trung bình Tenkan+Kijun) > Span B (trung bình 52 phiên) → mây XANH = bullish; ngược lại → ĐỎ = bearish. Mây dày = S/R mạnh.');

  // 4) CHIKOU SPAN vs GIÁ QUÁ KHỨ
  if (ic.chikou != null) {
    const pastClose = ic.series.closes[Math.max(0, ic.series.closes.length - 1 - 26)] || null;
    if (pastClose != null) {
      if (ic.chikou > pastClose) {
        score += 10;
        signals.push(`✅ Chikou Span (${ic.chikou.toFixed(2)}) > giá 26 phiên trước (${pastClose.toFixed(2)}) — momentum xác nhận BULLISH.`);
      } else {
        score -= 10;
        signals.push(`🔻 Chikou Span (${ic.chikou.toFixed(2)}) < giá 26 phiên trước — momentum xác nhận BEARISH.`);
      }
    }
  }
  education.push('**Chikou Span**: Đường giá hiện tại dịch lùi 26 phiên ra quá khứ. Nếu nó TRÊN giá quá khứ → momentum bullish; DƯỚI → bearish. Khi Chikou "tự do" (không bị giá cản) → xu hướng mạnh.');

  // Clamp score
  score = Math.max(0, Math.min(100, score));
  let verdict;
  if (score >= 80) verdict = 'Strong Bullish 🐂🐂';
  else if (score >= 60) verdict = 'Bullish 🐂';
  else if (score > 40) verdict = 'Neutral ➖';
  else if (score > 20) verdict = 'Bearish 🐻';
  else verdict = 'Strong Bearish 🐻🐻';

  // Gợi ý hành động dựa trên tổng thể
  if (score >= 65) {
    advice.push('🟢 **Hướng đi**: ưu tiên tìm điểm MUA. Đợi giá test lại Kijun hoặc mép trên mây rồi nảy lên — đó là vùng mua có R:R tốt.');
    advice.push('🛑 Stop-loss: đặt dưới Kijun-sen hoặc dưới đáy mây Kumo. Trailing theo Kijun khi giá chạy.');
  } else if (score <= 35) {
    advice.push('🔴 **Hướng đi**: tránh mua mới, cân nhắc giảm vị thế hoặc đợi short. Chỉ mua lại khi giá quay lại TRÊN mây + TK Cross lên.');
    advice.push('🛑 Nếu đang nắm giữ: stop-loss dưới đáy mây; gấp lệnh chỉ khi có tín hiệu đảo chiều rõ (TK Cross lên + giá phá trên mây).');
  } else {
    advice.push('🟡 **Hướng đi**: thị trường chưa rõ — CHỜ. Chỉ vào lệnh khi giá thoát khỏi mây Kumo + có TK Cross cùng chiều. Trong mây = nhiễu, dễ bị quét stop.');
  }

  education.push('💡 **Quy tắc vàng Ichimoku**: Tín hiệu mạnh nhất = 3 yếu tố đồng Thuận (TK Cross cùng chiều + Giá ngoài mây cùng chiều + Chikou tự do cùng chiều). Thiếu 1 yếu tố → tín hiệu yếu, nên giảm kích thước vị thế.');

  return { score, verdict, signals, advice, education };
}

/**
 * Text giáo dục tĩnh về Ichimoku cho người mới (hiện trong tab Kỹ thuật).
 */
const ICHIMOKU_GUIDE = [
  { t: 'Tenkan-sen (Đường chuyển đổi)', d: '(Cao nhất + Thấp nhất trong 9 phiên)/2. Đường NHANH, theo giá sát. Khi Tenkan đi ngang = giá đang tích lũy.' },
  { t: 'Kijun-sen (Đường cơ sở)', d: '(Cao nhất + Thấp nhất trong 26 phiên)/2. Đường CHẬM, là xương sống xu hướng. Giá thường nảy lên từ Kijun — dùng làm support chính & trailing stop.' },
  { t: 'Senkou Span A & B (Kumo)', d: 'Span A = (Tenkan+Kijun)/2, Span B = (Cao+Thấp 52 phiên)/2, đều DỊCH TRƯỚC 26 phiên. Khoảng giữa = ĐÁM MÂY (Kumo) = S/R động dự báo tương lai.' },
  { t: 'Chikou Span (Đường trễ)', d: 'Giá đóng cửa HIỆN TẠI dịch LÙI 26 phiên. So sánh với giá quá khứ để xác nhận momentum.' },
  { t: '3 tín hiệu chính', d: '(1) TK Cross — Tenkan cắt Kijun; (2) Giá ngoài mây; (3) Chikou tự do. 3 yếu tố cùng chiều = tín hiệu mạnh nhất.' },
  { t: 'Mây Xanh vs Mây Đỏ', d: 'Span A > Span B → mây XANH (hỗ trợ tăng). Span A < Span B → mây ĐỎ (kháng cự giảm). Mây càng dày = S/R càng mạnh.' }
];

module.exports = {
  donchian, tenkanSen, kijunSen, senkouSpanA, senkouSpanB, chikouSpan,
  computeIchimoku, interpretIchimoku, ICHIMOKU_GUIDE
};
