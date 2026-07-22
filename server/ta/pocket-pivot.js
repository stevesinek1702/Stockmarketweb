/**
 * Pocket Pivot (Kacher/Morales) — early entry signal.
 * Điều kiện: hôm nay là ngày TĂNG giá (close > close hôm trước) VÀ volume hôm nay
 * > MỌI ngày GIẢM giá trong 10 ngày giao dịch trước.
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[], volumes:number[]}} data
 * @returns {{detected:boolean, date:string|null, volumeRatio:number}}
 */
function detectPocketPivot({ dates, ohlc, volumes }) {
  const n = ohlc.length;
  if (n < 11) return { detected: false, date: null, volumeRatio: 0 };
  const last = n - 1;
  const todayUp = ohlc[last].c > ohlc[last - 1].c;
  if (!todayUp) return { detected: false, date: dates[last], volumeRatio: 0 };

  const todayVol = volumes[last];
  // 10 ngày trước hôm nay (last-10 ... last-1), chỉ lấy ngày GIẢM giá
  const window = [];
  for (let i = last - 10; i < last; i++) {
    if (i - 1 >= 0 && ohlc[i].c < ohlc[i - 1].c) {
      window.push(volumes[i]);
    }
  }
  if (window.length === 0) return { detected: false, date: dates[last], volumeRatio: 0 };
  const maxDownVol = Math.max(...window);
  const detected = todayVol > maxDownVol;
  return {
    detected,
    date: detected ? dates[last] : null,
    volumeRatio: maxDownVol > 0 ? todayVol / maxDownVol : 0
  };
}

module.exports = { detectPocketPivot };
