/**
 * ELLIOTT WAVE — heuristic nhận diện sóng + Fibonacci projection.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ĐÓNG VAI TRÒ CHUYÊN GIA ELLIOTT WAVE — nguyên lý:
 *
 * Lý thuyết Elliott: thị trường dao động theo chu kỳ có cấu trúc lặp.
 *  - SÓNG ĐỘNG LỰC (Impulse): 5 sóng (1,2,3,4,5) đi theo xu hướng chính.
 *      Sóng 1,3,5 cùng hướng xu hướng; sóng 2,4 ngược (điều chỉnh nhỏ).
 *      Quy tắc KHÔNG THỂ PHẠM:
 *        (R1) Sóng 2 KHÔNG được hồi quá đáy sóng 1.
 *        (R2) Sóng 3 KHÔNG phải sóng ngắn nhất trong 1,3,5.
 *        (R3) Sóng 4 KHÔNG được chạm vùng giá của sóng 1 (không trùng lặp).
 *      Sóng 3 thường là sóng MẠNH NHẤT, dài 1.618× sóng 1 (hay hơn).
 *      Quy tắc xen kẽ: sóng 2 và sóng 4 thường khác tính chất (2 sắc → 4 phẳng).
 *  - SÓNG ĐIỀU CHỈNH (Corrective): 3 sóng (A,B,C) ngược xu hướng chính.
 *      Sóng C thường = sóng A (hoặc 1.618×A) → mục tiêu kết thúc điều chỉnh.
 *
 * Fibonacci:
 *  - Retracement: 0.236, 0.382, 0.5, 0.618, 0.786 → vùng support/kháng cự hồi.
 *  - Extension: 0.618, 1.0, 1.272, 1.618, 2.618 → mục tiêu mục tiêu của sóng tiếp theo.
 *
 * ⚠️ DISCLAIMER: Elliott Wave vốn CHỦ QUAN — nhiều cách đếm sóng hợp lệ.
 * Module này dùng thuật toán HEURISTIC (zigzag swing + kiểm quy tắc), KHÔNG phải
 * chân lý. Kết quả = tham khảo phân tích, KHÔNG phải khuyến nghị đầu tư.
 * ─────────────────────────────────────────────────────────────────────────
 */

const FIB_RETRACEMENT = [0.236, 0.382, 0.5, 0.618, 0.786];
const FIB_EXTENSION = [0.618, 1.0, 1.272, 1.618, 2.618];

/**
 * Zigzag swing detection — tìm các đỉnh/đáy Swing (pivot) trong chuỗi giá.
 * Thuật toán 2 bước:
 *   1) Tìm local extremum: điểm i là pivot-high nếu high[i] = max trong ±window,
 *      pivot-low nếu low[i] = min trong ±window.
 *   2) Zigzag lọc: chỉ giữ biến động lớn hơn `threshold` (phần trăm) so với pivot
 *      trước, và ép luân phiên high/low.
 *
 * @param {number[]} closes
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number} threshold phần trăm tối thiểu để 1 swing được tính (vd 0.03 = 3%)
 * @returns {Array<{i:number, price:number, type:'high'|'low'}>} pivots ascending theo index
 */
function detectSwings(closes, highs, lows, threshold = 0.03) {
    const n = closes.length;
    if (n < 10) return [];
    const window = 3;

    // Bước 1: tìm tất cả local extremum thô
    const raw = [];
    for (let i = window; i < n - window; i++) {
        let isHigh = true, isLow = true;
        for (let j = i - window; j <= i + window; j++) {
            if (j === i) continue;
            if (highs[j] > highs[i]) isHigh = false;
            if (lows[j] < lows[i]) isLow = false;
        }
        if (isHigh) raw.push({ i, price: highs[i], type: 'high' });
        if (isLow) raw.push({ i, price: lows[i], type: 'low' });
    }
    if (raw.length === 0) return [];

    // Bước 2: zigzag — luân phiên high/low + lọc threshold
    raw.sort((a, b) => a.i - b.i);
    const result = [raw[0]];
    for (let k = 1; k < raw.length; k++) {
        const cur = raw[k];
        const last = result[result.length - 1];
        if (cur.type === last.type) {
            // Cùng hướng → giữ extremum khắc nghiệt hơn
            if (cur.type === 'high' ? cur.price > last.price : cur.price < last.price) {
                result[result.length - 1] = cur;
            }
        } else {
            // Đổi hướng → chỉ chấp nhận nếu đủ threshold so với pivot trước
            const pct = Math.abs(cur.price - last.price) / last.price;
            if (pct >= threshold) result.push(cur);
        }
    }
    return result;
}

/**
 * Tính các mốc Fibonacci retracement giữa 2 điểm giá (start→end của 1 sóng).
 * @param {number} start giá đầu sóng
 * @param {number} end giá cuối sóng
 * @returns {Object} {0.236, 0.382, 0.5, 0.618, 0.786} → các mức giá
 */
function fibRetracement(start, end) {
    const diff = end - start;
    const out = {};
    for (const r of FIB_RETRACEMENT) out[r] = end - diff * r;
    return out;
}

/**
 * Tính Fibonacci extension (mục tiêu sóng tiếp theo).
 * Dùng 3 điểm (W1 start, W1 end, W2 end) để đo sóng 3 mục tiêu.
 * @param {number} p0 start sóng 1
 * @param {number} p1 end sóng 1
 * @param {number} p2 end sóng 2 (retrace về)
 * @returns {Object} extension levels
 */
function fibExtension(p0, p1, p2) {
    const wave1 = Math.abs(p1 - p0);
    const dir = p1 > p0 ? 1 : -1; // hướng sóng động lực
    const out = {};
    for (const e of FIB_EXTENSION) out[e] = p2 + dir * wave1 * e;
    return out;
}

/**
 * Phân tích Elliott Wave — nhận diện cấu trúc sóng hiện tại + dự phóng.
// ═══════════════════════════════════════════════════════════════════════
// WAVE LABELING — dán nhãn 1-2-3-4-5 + A-B-C, đo trọng số, dự phóng tương lai
// (Nâng cấp theo yêu cầu: tìm lại trọng số từ quá khứ → vẽ lại tương lai)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Kiểm tra 3 quy tắc Elliott không thể phạm cho 1 chuỗi 5 sóng động lực.
 * Trả về {valid, score, violations} — score càng cao càng hợp lệ.
 *
 * 5 sóng = 6 điểm pivot (P0..P5): P0→P1=sóng1, P1→P2=sóng2, ... P4→P5=sóng5.
 * direction = 'up' nếu sóng động lực tăng (P1>P0), 'down' nếu giảm.
 *
 * Quy tắc:
 *  R1: sóng 2 không hồi quá điểm khởi đầu sóng 1 (P2 không vượt P0 theo chiều ngược).
 *  R2: sóng 3 không phải sóng ngắn nhất trong (sóng1, sóng3, sóng5).
 *  R3: sóng 4 không chạm vùng giá của sóng 1 (P4 không lấn vào vùng P0-P1).
 * Bonus: tỷ lệ wave3/wave1 gần 1.618, retrace sóng2 gần 0.5/0.618...
 *
 * @param {number[]} pivots 6 giá giá trị pivot [P0,P1,P2,P3,P4,P5]
 * @returns {{valid:boolean, score:number, direction:'up'|'down', violations:string[]}}
 */
function scoreImpulse(pivots) {
    const [p0, p1, p2, p3, p4, p5] = pivots;
    const violations = [];
    let score = 0;
    const direction = p1 > p0 ? 'up' : 'down';
    const sign = direction === 'up' ? 1 : -1;

    // Độ dài (abs) các sóng động lực 1,3,5 và điều chỉnh 2,4
    const w1 = Math.abs(p1 - p0);
    const w2 = Math.abs(p2 - p1);
    const w3 = Math.abs(p3 - p2);
    const w4 = Math.abs(p4 - p3);
    const w5 = Math.abs(p5 - p4);

    // R1: sóng 2 không hồi quá P0. Uptrend: P2 > P0; Downtrend: P2 < P0
    const r1Ok = direction === 'up' ? p2 > p0 : p2 < p0;
    if (r1Ok) score += 30; else violations.push('R1 vi phạm: sóng 2 hồi quá điểm khởi đầu sóng 1');

    // R2: sóng 3 không ngắn nhất trong 1,3,5
    const r2Ok = w3 >= Math.min(w1, w5);
    if (r2Ok) score += 30; else violations.push('R2 vi phạm: sóng 3 ngắn nhất (không hợp lệ)');

    // R3: sóng 4 không chạm vùng sóng 1 (không trùng lặp)
    // Uptrend: P4 > max(P0,P1)→ thực ra P4 phải > P1 (không lấn vào vùng sóng1).
    // Chuẩn: vùng sóng1 = [min(P0,P1), max(P0,P1)]; P4 không nằm trong vùng đó.
    const lo1 = Math.min(p0, p1), hi1 = Math.max(p0, p1);
    const r3Ok = direction === 'up' ? p4 > hi1 : p4 < lo1;
    if (r3Ok) score += 30; else violations.push('R3 vi phạm: sóng 4 trùng vùng giá sóng 1');

    // Bonus: sóng 3 thường dài ~1.618× sóng 1 (Fibonacci golden ratio)
    if (w1 > 0) {
        const ratio = w3 / w1;
        // gần 1.618 (trong ±25%) → +5 điểm; gần 1.0/2.618 → +2
        if (ratio >= 1.21 && ratio <= 2.02) score += 5;
        else if (ratio >= 0.8 && ratio <= 2.6) score += 2;
    }
    // Bonus: retrace sóng 2 thường 50-61.8%
    if (w1 > 0) {
        const retrace2 = w2 / w1;
        if (retrace2 >= 0.35 && retrace2 <= 0.75) score += 3;
    }
    // Bonus: sóng 5 ≈ 0.618× hoặc 1.0× sóng 1
    if (w1 > 0) {
        const r5 = w5 / w1;
        if ((r5 >= 0.5 && r5 <= 0.8) || (r5 >= 0.9 && r5 <= 1.15)) score += 2;
    }

    return { valid: r1Ok && r2Ok && r3Ok, score, direction, violations };
}

/**
 * LABEL WAVES — dán nhãn 1-2-3-4-5 (impulse) + A-B-C (corrective) cho swings.
 * Quét cửa sổ trượt 8 swing liên tiếp (= 1 chu kỳ 5-3 hoàn chỉnh: 6 pivot cho 5 sóng
 * động lực + 2 pivot thêm cho ABC), chấm điểm impulse, giữ tổ hợp điểm cao nhất.
 *
 * @param {Array<{i,price,type}>} swings
 * @returns {{labels:Array, pattern:string, score:number, direction:string, cycles:Array}}
 *   labels: [{i, price, label:'1'|'2'|'3'|'4'|'5'|'A'|'B'|'C'}] — nhãn cho mỗi pivot
 *   cycles: danh sách các chu kỳ 5-3 hoàn thành (để measureWaveRatios dùng)
 */
function labelWaves(swings) {
    if (!Array.isArray(swings) || swings.length < 6) {
        return { labels: [], pattern: 'Chưa đủ swings để dán nhãn', score: 0, direction: null, cycles: [] };
    }

    let best = { score: -1, labels: [], cycles: [], startIdx: -1, direction: null };

    // Quét mọi cửa sổ: 9 pivot (6 impulse + 3 ABC đầy đủ) → 6 (chỉ impulse).
    // Ưu tiên cửa sổ lớn để bắt được cả chu kỳ điều chỉnh.
    const windowSizes = [];
    if (swings.length >= 9) windowSizes.push(9);
    if (swings.length >= 8) windowSizes.push(8); // impulse + AB (C chưa hoàn thành)
    windowSizes.push(6); // chỉ impulse
    for (const win of windowSizes) {
        for (let start = 0; start + win <= swings.length; start++) {
            const window = swings.slice(start, start + win);
            const prices = window.map(s => s.price);
            // 6 pivot đầu = impulse 5 sóng
            const impulsePivots = prices.slice(0, 6);
            const res = scoreImpulse(impulsePivots);
            if (!res.valid) continue;
            // Ưu tiên cửa sổ bắt được nhiều sóng hơn (bonus điểm cho ABC đầy đủ)
            let score = res.score;
            if (win === 9) score += 10;
            else if (win === 8) score += 5;
            if (score > best.score) {
                const labels = [];
                // Impulse: pivot 0-5 → nhãn 0(start),1,2,3,4,5
                const impLabels = ['0', '1', '2', '3', '4', '5'];
                for (let k = 0; k < 6; k++) {
                    labels.push({ i: window[k].i, price: window[k].price, label: impLabels[k] });
                }
                // Corrective ABC: pivot 5(kết thúc sóng5=khởi đầu A), 6(A), 7(B), 8(C)
                const cycles = [{ pivots: impulsePivots.slice(), direction: res.direction }];
                if (win >= 8) {
                    labels.push({ i: window[6].i, price: window[6].price, label: 'A' });
                    labels.push({ i: window[7].i, price: window[7].price, label: 'B' });
                    if (win >= 9 && window[8]) {
                        labels.push({ i: window[8].i, price: window[8].price, label: 'C' });
                        cycles.push({
                            pivots: [prices[5], prices[6], prices[7], prices[8]],
                            direction: res.direction === 'up' ? 'down' : 'up', type: 'abc'
                        });
                    }
                }
                best = { score, labels, cycles, startIdx: start, direction: res.direction };
            }
        }
    }

    // Nếu có đủ swings, thử tìm thêm chu kỳ thứ 2 (sau chu kỳ tốt nhất) để multi-cycle measure
    // — bỏ qua nếu chỉ 1 chu kỳ.

    const pattern = best.score > 0
        ? `IMPULSE ${best.direction === 'up' ? 'TĂNG' : 'GIẢM'} + ABC (đếm sóng hợp lệ, điểm ${best.score})`
        : 'Không tìm được chu kỳ 5-3 hợp lệ trong swings hiện tại';
    return {
        labels: best.labels,
        pattern,
        score: best.score,
        direction: best.direction,
        cycles: best.cycles
    };
}

/**
 * MEASURE WAVE RATIOS — đo "trọng số" thực tế: tỷ lệ các sóng từ chu kỳ đã hoàn thành.
 * Đây là "tính cách sóng" riêng của mã — thay cho số Fibonacci sách giáo khoa.
 *
 * @param {Array} cycles — output của labelWaves (mỗi cycle = {pivots, direction})
 * @returns {Object} {wave3OverWave1, wave5OverWave1, retrace2Pct, retrace4Pct, waveCOverWaveA, sampleCount, note}
 */
function measureWaveRatios(cycles) {
    const w3w1 = [], w5w1 = [], retr2 = [], retr4 = [], cOverA = [];
    let impCount = 0, abcCount = 0;

    for (const cyc of cycles) {
        if (cyc.type === 'abc') {
            // ABC: pivots = [start, A_end, B_end, C_end]; A = |A_end-start|, C = |C_end-B_end|
            const [s, a, b, c] = cyc.pivots;
            const waveA = Math.abs(a - s);
            const waveC = Math.abs(c - b);
            if (waveA > 0) cOverA.push(waveC / waveA);
            abcCount++;
        } else {
            // Impulse: pivots = [P0..P5]
            const [p0, p1, p2, p3, p4, p5] = cyc.pivots;
            const w1 = Math.abs(p1 - p0), w2 = Math.abs(p2 - p1), w3 = Math.abs(p3 - p2);
            const w4 = Math.abs(p4 - p3), w5 = Math.abs(p5 - p4);
            if (w1 > 0) {
                w3w1.push(w3 / w1);
                w5w1.push(w5 / w1);
                retr2.push(w2 / w1);
                retr4.push(w4 / w3 > 0 ? w4 / w3 : 0);
            }
            impCount++;
        }
    }
    const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000 : null;
    const sampleCount = impCount + abcCount;
    return {
        wave3OverWave1: avg(w3w1),     // chuẩn ~1.618
        wave5OverWave1: avg(w5w1),     // chuẩn ~0.618 hoặc 1.0
        retrace2Pct: avg(retr2) ? Math.round(avg(retr2) * 1000) / 10 : null,  // chuẩn 50-61.8%
        retrace4Pct: avg(retr4) ? Math.round(avg(retr4) * 1000) / 10 : null,  // chuẩn 23.6-38.2%
        waveCOverWaveA: avg(cOverA),   // chuẩn ~1.0 hoặc 1.618
        sampleCount,
        note: sampleCount === 0
            ? 'Chưa đủ chu kỳ hoàn thành để đo trọng số — dùng Fibonacci chuẩn.'
            : `Trọng số đo từ ${impCount} chu kỳ động lực + ${abcCount} chu kỳ điều chỉnh.`
    };
}

/**
 * PROJECT FUTURE — dựng các đoạn sóng tương lai từ vị trí hiện tại + trọng số đo được.
 * Nếu trọng số null (chưa đủ mẫu) → fallback Fibonacci chuẩn (1.618, 0.618...).
 *
 * @param {Array} labels — nhãn sóng từ labelWaves
 * @param {Object} ratios — trọng số từ measureWaveRatios
 * @param {number} currentPrice — giá đóng cửa hiện tại
 * @param {string} direction — 'up'/'down' của chu kỳ động lực
 * @returns {Object} {currentWave, futureSegments, targets, note}
 *   futureSegments: [{fromPrice, toPrice, label, barsAhead}]
 *   targets: [{price, level, dir}]
 */
function projectFuture(labels, ratios, currentPrice, direction) {
    // Fallback Fibonacci chuẩn nếu không đo được trọng số
    const w3Ratio = ratios.wave3OverWave1 || 1.618;
    const w5Ratio = ratios.wave5OverWave1 || 0.618;
    const retr2 = ratios.retrace2Pct != null ? ratios.retrace2Pct / 100 : 0.618;
    const retr4 = ratios.retrace4Pct != null ? ratios.retrace4Pct / 100 : 0.382;
    const usedFallback = ratios.sampleCount === 0;

    // Xác định sóng hiện tại: tìm nhãn lớn nhất đã dán + xem giá vs pivot cuối
    const labelOrder = ['0', '1', '2', '3', '4', '5', 'A', 'B', 'C'];
    let lastLabelIdx = -1;
    let lastPivot = null;
    for (const lbl of labels) {
        const o = labelOrder.indexOf(lbl.label);
        if (o > lastLabelIdx) { lastLabelIdx = o; lastPivot = lbl; }
    }

    const sign = direction === 'up' ? 1 : -1;
    const futureSegments = [];
    const targets = [];
    let currentWave = 'Không xác định';

    // Nếu đã dán nhãn đến sóng X, giả định sóng tiếp theo chưa hoàn thành
    // Lấy sóng 1 làm tham chiếu nếu có (P0,P1)
    const p0 = labels.find(l => l.label === '0');
    const p1 = labels.find(l => l.label === '1');
    const wave1Len = (p0 && p1) ? Math.abs(p1.price - p0.price) : currentPrice * 0.05;

    if (lastLabelIdx >= 0 && lastLabelIdx <= 4) {
        // Đang trong impulse — dự phóng các sóng động lực còn lại
        // lastLabel = '0'..'4' → sóng kế tiếp = next
        const nextIdx = lastLabelIdx + 1;
        currentWave = `Sóng ${labelOrder[nextIdx]} (đang hình thành)`;
        let from = currentPrice;
        // Dự phóng từ sóng hiện tại đến sóng 5
        for (let s = nextIdx; s <= 5; s++) {
            let segLen;
            if (s === 1) segLen = wave1Len;
            else if (s === 2) segLen = wave1Len * retr2;
            else if (s === 3) segLen = wave1Len * w3Ratio;
            else if (s === 4) segLen = (wave1Len * w3Ratio) * retr4;
            else if (s === 5) segLen = wave1Len * w5Ratio;
            else segLen = wave1Len * 0.5;
            // direction của sóng: 1,3,5 cùng direction; 2,4 ngược
            const segSign = (s % 2 === 0) ? -sign : sign;
            const to = from + segSign * segLen;
            futureSegments.push({ fromPrice: Math.round(from * 100) / 100, toPrice: Math.round(to * 100) / 100, label: String(s), barsAhead: (s - nextIdx + 1) * 8 });
            targets.push({ price: Math.round(to * 100) / 100, level: `Mục tiêu sóng ${s}`, dir: to > currentPrice ? 'trên' : 'dưới' });
            from = to;
        }
    } else if (lastLabelIdx >= 5) {
        // Đã hoàn thành impulse → đang trong điều chỉnh ABC
        currentWave = lastLabelIdx === 5 ? 'Sóng A (điều chỉnh)' : (lastLabelIdx === 6 ? 'Sóng B' : 'Sóng C / hoàn thành điều chỉnh');
        // Mục tiêu kết thúc điều chỉnh = hồi về retrace của toàn impulse (thường 0.382-0.618)
        const p5 = labels.find(l => l.label === '5');
        const impStart = p0 ? p0.price : currentPrice;
        const impEnd = p5 ? p5.price : currentPrice;
        const impLen = Math.abs(impEnd - impStart);
        // Điều chỉnh thường hồi về 0.382-0.618 của toàn impulse
        [0.382, 0.5, 0.618].forEach(r => {
            const target = impEnd - sign * impLen * r;
            targets.push({ price: Math.round(target * 100) / 100, level: `Hồi ${Math.round(r * 100)}%`, dir: target > currentPrice ? 'trên' : 'dưới' });
        });
    }

    return {
        currentWave,
        futureSegments,
        targets,
        usedFallback,
        note: usedFallback
            ? 'Dùng Fibonacci chuẩn (chưa đủ mẫu đo trọng số).'
            : `Dự phóng bằng trọng số thực tế của mã (w3/w1=${w3Ratio}, retrace2=${Math.round(retr2 * 100)}%).`
    };
}


/**
 * Phân tích Elliott Wave — nhận diện cấu trúc sóng hiện tại + dự phóng.
 * Heuristic: từ swings gần nhất (lấy ~8-10 pivot cuối), đoán đang ở sóng nào
 * trong chu kỳ 5-3, tính Fibonacci retracement/extension cho các mục tiêu.
 * Nâng cấp: dán nhãn sóng (labelWaves) + đo trọng số (measureWaveRatios) +
 * dự phóng tương lai (projectFuture).
 *
 * @param {{dates:string[], ohlc:{o,h,l,c}[]}} history
 * @returns {Object} {swings, waveLabels, waveRatios, futureProjection, currentWave, pattern, fibLevels, notes, disclaimer}
 */
function analyzeElliott(history) {
    const ohlc = history.ohlc || [];
    if (ohlc.length < 60) {
        return { success: false, error: 'Cần ít nhất 60 phiên để phân tích Elliott Wave.' };
    }
    const highs = ohlc.map(x => x.h);
    const lows = ohlc.map(x => x.l);
    const closes = ohlc.map(x => x.c);
    const dates = history.dates || [];
    const n = closes.length;

    // 1) Phát hiện swings (threshold thích ứng: thử 3% → nếu ít swing, hạ 2% → 1.5%)
    let swings = detectSwings(closes, highs, lows, 0.03);
    if (swings.length < 5) swings = detectSwings(closes, highs, lows, 0.02);
    if (swings.length < 5) swings = detectSwings(closes, highs, lows, 0.015);
    if (swings.length < 3) {
        return {
            success: true,
            swings,
            note: 'Biến động quá ít để xác định cấu trúc sóng rõ ràng. Thị trường có thể đang tích lũy hẹp hoặc trend quá mượt.',
            disclaimer: ELLIOTT_DISCLAIMER
        };
    }

    // Lấy ~10 swings gần nhất để phân tích chu kỳ hiện tại
    const recent = swings.slice(-10);
    const lastPrice = closes[n - 1];
    const lastSwing = recent[recent.length - 1];

    // 2) Xác định xu hướng chính (trend) = hướng từ swing đầu → swing cuối của recent
    const firstSwing = recent[0];
    const trendDir = lastSwing.price > firstSwing.price ? 'up' : 'down';

    // 3) Đoán cấu trúc sóng: đếm số swing theo trend vs ngược trend
    //    Trong impulse: các swing theo trend dài hơn; trong corrective: cân bằng hơn
    let withTrend = 0, againstTrend = 0;
    for (let i = 1; i < recent.length; i++) {
        const move = Math.abs(recent[i].price - recent[i - 1].price);
        const isWithTrend = (trendDir === 'up' && recent[i].type === 'high') ||
                            (trendDir === 'down' && recent[i].type === 'low');
        if (isWithTrend) withTrend += move; else againstTrend += move;
    }
    const trendStrength = withTrend / (withTrend + againstTrend || 1); // 0-1

    // 4) Pattern guess: nếu trend mạnh (>0.6) → khả năng đang trong impulse (sóng động lực)
    //    nếu trend yếu (<0.45) → khả năng đang trong corrective (điều chỉnh ABC)
    let pattern, currentWave, fibLevels = null, projection = null;

    // Tìm 2 sóng gần nhất để tính Fib retracement (từ đỉnh/đáy gần nhất)
    // last completed move = swing[-2] → swing[-1]
    const p0 = recent.length >= 3 ? recent[recent.length - 3].price : firstSwing.price;
    const p1 = recent.length >= 2 ? recent[recent.length - 2].price : lastSwing.price;
    const p2 = lastSwing.price;

    if (trendStrength >= 0.55) {
        // Xu hướng mạnh → đoán IMPULSE pattern
        // Đếm số đỉnh/đáy theo trend để guess đang ở sóng 1/3/5
        const highCount = recent.filter(s => s.type === 'high').length;
        const lowCount = recent.filter(s => s.type === 'low').length;
        // Số sóng động lực đã qua ~ số swing "đỉnh" trong uptrend (hoặc "đáy" trong downtrend)
        const impulseWaves = trendDir === 'up' ? highCount : lowCount;
        if (impulseWaves >= 3) currentWave = trendDir === 'up' ? 'Sóng 5 (giai đoạn cuối impulse tăng)' : 'Sóng 5 (impulse giảm)';
        else if (impulseWaves === 2) currentWave = trendDir === 'up' ? 'Sóng 3 (giai đoạn mạnh nhất impulse tăng)' : 'Sóng 3 (impulse giảm)';
        else currentWave = trendDir === 'up' ? 'Sóng 1 (khởi đầu impulse tăng)' : 'Sóng 1 (khởi đầu impulse giảm)';

        pattern = `IMPULSE (${trendDir === 'up' ? 'TĂNG' : 'GIẢM'}) — xu hướng chính rõ (cường độ ${(trendStrength * 100).toFixed(0)}%)`;

        // Fib retracement: nếu giá đang retrace → support
        fibLevels = fibRetracement(p0, p1);
        // Fib extension: mục tiêu sóng tiếp theo (dùng 3 điểm)
        projection = fibExtension(p0, p1, p2);
    } else {
        // Trend yếu → đoán CORRECTIVE (A-B-C)
        pattern = `CORRECTIVE (ĐIỀU CHỈNH) — xu hướng chính yếu (cường độ ${(trendStrength * 100).toFixed(0)}%), thị trường đang ngược/sideway`;
        currentWave = 'Sóng điều chỉnh (A-B-C)';
        fibLevels = fibRetracement(p0, p1);
        projection = fibExtension(p0, p1, p2);
    }

    // 5) Vị trí giá hiện tại vs Fib levels
    const fibPosition = { lastPrice };
    if (fibLevels) {
        // Tìm mức Fib gần nhất phía trên (resistance) và dưới (support)
        let above = null, below = null;
        for (const [r, lvl] of Object.entries(fibLevels)) {
            if (lvl >= lastPrice && (!above || lvl < above.lvl)) above = { r: parseFloat(r), lvl };
            if (lvl <= lastPrice && (!below || lvl > below.lvl)) below = { r: parseFloat(r), lvl };
        }
        fibPosition.nearestSupport = below;
        fibPosition.nearestResistance = above;
    }

    // 6) Gợi ý target từ projection
    const targets = [];
    if (projection) {
        for (const [e, lvl] of Object.entries(projection)) {
            targets.push({ ext: parseFloat(e), price: Math.round(lvl * 100) / 100, dir: lvl > lastPrice ? 'trên' : 'dưới' });
        }
    }

    // 7) DÁN NHÃN SÓNG + ĐO TRỌNG SỐ + DỰ PHÓNG TƯƠNG LAI (nâng cấp chính)
    //    Dùng swings gần đây (lấy tới 12 pivot để bắt được nhiều chu kỳ) — đếm sóng
    //    chính thức theo 3 quy tắc Elliott, đo "tính cách sóng" riêng của mã.
    const labelSwings = swings.slice(-12);
    const waveLabels = labelWaves(labelSwings);
    const waveRatios = measureWaveRatios(waveLabels.cycles);
    // Direction cho projectFuture: ưu tiên direction từ labelWaves (chu kỳ động lực),
    // fallback trendDir tổng thể
    const projDir = waveLabels.direction || trendDir;
    const futureProjection = projectFuture(waveLabels.labels, waveRatios, lastPrice, projDir);

    return {
        success: true,
        lastPrice: Math.round(lastPrice * 100) / 100,
        lastDate: dates[n - 1] || null,
        trendDir,
        trendStrength: Math.round(trendStrength * 100) / 100,
        pattern,
        currentWave,
        // Series close + dates để frontend vẽ chart; swings mang index i (đánh dấu pivot)
        series: { dates: dates.slice(), close: closes.slice() },
        swings: recent.map(s => ({ i: s.i, date: dates[s.i] || null, price: s.price, type: s.type })),
        fibLevels: fibLevels ? roundObj(fibLevels) : null,
        fibPosition,
        projectionTargets: targets,
        // ── Nâng cấp: nhãn sóng + trọng số + dự phóng tương lai ──
        waveLabels: {
            labels: waveLabels.labels.map(l => ({ ...l, date: dates[l.i] || null })),
            pattern: waveLabels.pattern,
            score: waveLabels.score,
            direction: waveLabels.direction
        },
        waveRatios,
        futureProjection,
        notes: buildElliottNotes(trendDir, trendStrength, currentWave, fibPosition, waveRatios, futureProjection),
        disclaimer: ELLIOTT_DISCLAIMER
    };
}

function roundObj(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = Math.round(v * 100) / 100;
    return out;
}

/**
 * Ghi chú phân tích — đóng vai chuyên gia Elliott giải thích kết quả.
 */
function buildElliottNotes(trendDir, strength, currentWave, fibPos, ratios, futureProj) {
    const notes = [];
    notes.push(`Xu hướng chính: **${trendDir === 'up' ? 'TĂNG' : 'GIẢM'}** với cường độ **${(strength * 100).toFixed(0)}%**.`);
    if (strength >= 0.6) {
        notes.push(`Cường độ xu hướng mạnh → khả năng đang trong **sóng động lực (Impulse)**. Đây là pha "đi theo xu hướng" — ưu tiên trade cùng chiều.`);
    } else if (strength >= 0.45) {
        notes.push(`Cường độ trung bình → xu hướng chưa rõ ràng, cẩn thận whipsaw.`);
    } else {
        notes.push(`Cường độ yếu → thị trường đang trong **pha điều chỉnh (Corrective A-B-C)** hoặc sideway. Trade trong pha này rủi ro cao, chờ xác nhận kết thúc điều chỉnh.`);
    }
    notes.push(`Vị trí hiện tại: **${currentWave}**.`);

    // Trọng số đo được từ quá khứ (nâng cấp chính)
    if (ratios && ratios.sampleCount > 0) {
        const parts = [];
        if (ratios.wave3OverWave1 != null) parts.push(`sóng 3 = ${ratios.wave3OverWave1}× sóng 1 (chuẩn 1.618)`);
        if (ratios.retrace2Pct != null) parts.push(`sóng 2 hồi ${ratios.retrace2Pct}% (chuẩn 50-62%)`);
        if (ratios.waveCOverWaveA != null) parts.push(`sóng C = ${ratios.waveCOverWaveA}× sóng A (chuẩn 1.0)`);
        if (parts.length) {
            notes.push(`🔬 **Trọng số thực tế** đo từ ${ratios.sampleCount} chu kỳ quá khứ: ${parts.join('; ')}. Đây là "tính cách sóng" riêng của mã → dự phóng chính xác hơn số Fibonacci chung.`);
        }
    } else {
        notes.push(`🔬 Chưa đủ chu kỳ hoàn thành để đo trọng số — dự phóng dùng **Fibonacci chuẩn** (1.618, 0.618...).`);
    }

    // Dự phóng tương lai
    if (futureProj && futureProj.targets && futureProj.targets.length) {
        const t = futureProj.targets[0];
        notes.push(`🔮 ${futureProj.note} Mục tiêu gần nhất: **${t.price}** (${t.level}, ${t.dir} giá hiện tại).`);
    }

    if (fibPos && fibPos.nearestSupport && fibPos.nearestResistance) {
        notes.push(`Support Fib gần nhất: **${fibPos.nearestSupport.lvl}** (mức ${fibPos.nearestSupport.r}). Resistance Fib gần nhất: **${fibPos.nearestResistance.lvl}** (mức ${fibPos.nearestResistance.r}).`);
    }
    notes.push(`Quy tắc Elliott: sóng 3 thường dài nhất (1.618× sóng 1) và mạnh nhất; sóng 2 không hồi quá sóng 1; sóng 4 không trùng vùng sóng 1.`);
    return notes;
}

const ELLIOTT_DISCLAIMER = '⚠️ Elliott Wave vốn chủ quan — có nhiều cách đếm sóng hợp lệ cùng lúc. Đây là phân tích HEURISTIC tham khảo, KHÔNG phải khuyến nghị đầu tư. Luôn kết hợp quản trị rủi ro + xác nhận bằng các chỉ báo khác.';

const ELLIOTT_GUIDE = [
  { t: 'Sóng động lực (Impulse)', d: '5 sóng (1-2-3-4-5) đi theo xu hướng chính. Sóng 1,3,5 cùng hướng; sóng 3 thường dài + mạnh nhất (1.618× sóng 1).' },
  { t: 'Sóng điều chỉnh (Corrective)', d: '3 sóng (A-B-C) ngược xu hướng chính. Sóng C thường = sóng A hoặc 1.618×A → dự báo kết thúc điều chỉnh.' },
  { t: '3 quy tắc không thể phạm', d: '(1) Sóng 2 không hồi quá đáy sóng 1; (2) Sóng 3 không phải sóng ngắn nhất; (3) Sóng 4 không chạm vùng sóng 1. Vi phạm = đếm sai.' },
  { t: 'Fibonacci Retracement', d: '0.236, 0.382, 0.5, 0.618, 0.786 — vùng giá hồi về sau 1 sóng. Dùng tìm support/kháng cự + entry.' },
  { t: 'Fibonacci Extension', d: '0.618, 1.0, 1.272, 1.618, 2.618 — mục giá mục tiêu của sóng tiếp theo (vd target sóng 3, sóng C).' }
];

module.exports = {
    detectSwings, fibRetracement, fibExtension, analyzeElliott,
    scoreImpulse, labelWaves, measureWaveRatios, projectFuture,
    ELLIOTT_DISCLAIMER, ELLIOTT_GUIDE, FIB_RETRACEMENT, FIB_EXTENSION
};
