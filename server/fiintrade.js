/**
 * FIINTRADE DATA MODULE
 * ─────────────────────────────────────────────────────────────────────────
 * Lấy dữ liệu từ các endpoint công khai wl-*.fiintrade.vn.
 *
 * QUAN TRỌNG: các endpoint này CHỈ cần header "Origin" mang danh nghĩa SSI iBoard
 * (https://iboard.ssi.com.vn) là chạy 200 — KHÔNG cần đăng nhập / token / cookie.
 * (Đã kiểm chứng trong "Thu thap du lieu/Code Multi CP.txt".)
 *
 * Dùng để thay thế nguồn Fitrade (apigw.fitrade.vn) đã chết cho tính năng
 * "Dòng tiền ngành" và bổ sung "Phân tích lệnh" theo 4 nhóm nhà đầu tư.
 */

const axios = require('axios');

const BILLION = 1e9;

const FII_HEADERS = {
    'accept': 'application/json',
    'origin': 'https://iboard.ssi.com.vn',
    'referer': 'https://iboard.ssi.com.vn/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

const round1 = (x) => Math.round((x || 0) * 10) / 10;

// Bỏ hậu tố " L1"/" L2" trong tên ngành ICB của Fiintrade (vd "Bất động sản L2")
const cleanSectorName = (name) => String(name || '').replace(/\s*L\d+\s*$/i, '').trim();

async function fiinGet(url) {
    // Đếm API call tới Fiintrade
    try { require('./cache').apiCounter.bump('fiintrade').catch(() => {}); } catch (e) {}
    const res = await axios.get(url, { headers: FII_HEADERS, timeout: 15000 });
    return res.data;
}

// ── Ticker → organCode map (cache 6h) ──────────────────────────────
// Một số mã (vd BSR) cần organCode khác ticker (BSR→BSRC) để GetPriceData
// chấp nhận. Nguồn: wl-core.fiintrade.vn/Master/GetListOrganization.
let _organCodeMap = null;
let _organCodeMapTime = 0;
const ORGAN_CODE_TTL = 6 * 3600 * 1000; // 6 giờ

async function getOrganCodeMap() {
    if (_organCodeMap && Date.now() - _organCodeMapTime < ORGAN_CODE_TTL) {
        return _organCodeMap;
    }
    try {
        const url = 'https://wl-core.fiintrade.vn/Master/GetListOrganization?language=vi';
        const data = await fiinGet(url);
        const items = (data && data.items) || [];
        const map = {};
        items.forEach(it => {
            if (it.ticker && it.organCode) {
                map[String(it.ticker).toUpperCase()] = it.organCode;
            }
        });
        _organCodeMap = map;
        _organCodeMapTime = Date.now();
        console.log(`📊 OrganCode map loaded: ${Object.keys(map).length} tickers`);
        return map;
    } catch (e) {
        console.warn('⚠️ OrganCode map fetch fail:', e.message);
        return _organCodeMap || {};
    }
}

/**
 * Resolve ticker → organCode (fallback = ticker nếu không có trong map).
 */
async function resolveOrganCode(ticker) {
    const map = await getOrganCodeMap();
    const code = String(ticker || '').trim().toUpperCase();
    return map[code] || code;
}

/**
 * Dòng tiền ròng (khớp lệnh) theo ngành, tách theo 4 nhóm NĐT.
 * @param {number} timeRange 1 (1 ngày) | 5 (5 ngày) | 20 (20 ngày) | 0 (từ đầu năm)
 * @param {number} icbLevel 1 (10 ngành) | 2 (18 ngành)
 * @returns {Promise<{fromDate:string,toDate:string,data:Array}>}
 */
async function getSectorFlow(timeRange = 1, icbLevel = 2) {
    const url = `https://wl-market.fiintrade.vn/SectorIndepth/GetSectorStatisticbyInvestor`
        + `?icbLevel=${icbLevel}&timeRange=${timeRange}&language=vi`;
    const data = await fiinGet(url);
    const items = (data && data.items) || [];

    const results = items.map(it => {
        const caNhan = (it.netIndividualMatchValue || 0) / BILLION;     // Cá nhân
        const toChuc = (it.netInstitutionMatchValue || 0) / BILLION;    // Tổ chức trong nước
        const tuDoanh = (it.netProprietaryMatchValue || 0) / BILLION;   // Tự doanh
        const nuocNgoai = (it.netForeignMatchValue || 0) / BILLION;     // Nước ngoài
        // "Dòng tiền lớn" = tất cả nhóm trừ cá nhân (zero-sum: = -caNhan)
        const netSmart = toChuc + tuDoanh + nuocNgoai;
        return {
            code: it.icbCode,
            name: cleanSectorName(it.icbName),
            closeIndex: round1(it.closeIndex),
            percentChange: round1((it.percentIndexChange || 0) * 100),
            caNhan: round1(caNhan),
            toChuc: round1(toChuc),
            tuDoanh: round1(tuDoanh),
            nuocNgoai: round1(nuocNgoai),
            netSmart: round1(netSmart)
        };
    });

    // Sắp xếp theo dòng tiền lớn (mạnh nhất trước)
    results.sort((a, b) => b.netSmart - a.netSmart);

    const fromDate = items[0]?.fromDate ? String(items[0].fromDate).slice(0, 10) : null;
    const toDate = items[0]?.toDate ? String(items[0].toDate).slice(0, 10) : null;
    return { fromDate, toDate, data: results };
}

/**
 * Dòng tiền ròng TOÀN THỊ TRƯỜNG theo 4 nhóm NĐT, tổng hợp từ 10 ngành cấp 1.
 * (icbLevel=1 phủ toàn bộ cổ phiếu niêm yết.)
 * @param {number} timeRange
 */
async function getMarketInvestorFlow(timeRange = 1) {
    const { data, fromDate, toDate } = await getSectorFlow(timeRange, 1);
    const sum = (key) => data.reduce((s, d) => s + (d[key] || 0), 0);
    return {
        timeRange,
        fromDate,
        toDate,
        caNhan: round1(sum('caNhan')),
        toChuc: round1(sum('toChuc')),
        tuDoanh: round1(sum('tuDoanh')),
        nuocNgoai: round1(sum('nuocNgoai'))
    };
}

/**
 * Khối ngoại (khớp lệnh) Mua / Bán / Ròng toàn thị trường cho 3 mốc:
 *   today (hôm nay) · oneWeek (1 tuần) · oneMonth (1 tháng).
 * Nguồn: Fiintrade MoneyFlow/GetStatisticInvestor?investorType=ForeignMatch.
 *
 * QUAN TRỌNG: net "sạch" = foreignBuyValue − foreignSellValue (tổng mua/bán khớp lệnh
 * của khối ngoại). KHÔNG dùng foreignNetBuyValue/foreignNetSellValue vì đó là tổng
 * phần net DƯƠNG / net ÂM theo từng mã (gross), không phải net toàn thị trường.
 * (Đã kiểm chứng: foreignBuyValue−foreignSellValue == foreignNetBuyValue−foreignNetSellValue,
 *  và khớp với getMarketInvestorFlow(1/5).nuocNgoai.)
 *
 * @param {string} comGroupCode mã nhóm chỉ số ('VNINDEX' mặc định)
 * @returns {Promise<{today,oneWeek,oneMonth}>} mỗi mốc: {buy,sell,net,fromDate,toDate} (tỷ đồng) hoặc null
 */
async function getForeignStatistic(comGroupCode = 'VNINDEX') {
    const url = `https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor`
        + `?language=vi&comGroupCode=${encodeURIComponent(comGroupCode)}&investorType=ForeignMatch`;
    const data = await fiinGet(url);
    const it = (data && data.items && data.items[0]) || {};

    const pick = (o) => {
        if (!o) return null;
        const buy = (o.foreignBuyValue || 0) / BILLION;
        const sell = (o.foreignSellValue || 0) / BILLION;
        return {
            buy: round1(buy),
            sell: round1(sell),
            net: round1(buy - sell),
            fromDate: o.fromDate ? String(o.fromDate).slice(0, 10) : null,
            toDate: o.toDate ? String(o.toDate).slice(0, 10) : null
        };
    };

    return {
        today: pick(it.today),
        oneWeek: pick(it.oneWeek),
        oneMonth: pick(it.oneMonth)
    };
}

/**
 * 4 nhóm nhà đầu tư trên Fiintrade MoneyFlow/GetStatisticInvestor.
 * Các field giá trị (foreignBuyValue/foreignSellValue) là TÊN CHUNG: chúng mang
 * giá trị của đúng investorType được yêu cầu (đã kiểm chứng cho cả 4 nhóm).
 */
const INVESTOR_TYPES = {
    individual:  { api: 'LocalIndividualMatch',  name: 'Cá nhân' },
    institution: { api: 'LocalInstitutionMatch', name: 'Tổ chức' },
    proprietary: { api: 'ProprietaryMatch',      name: 'Tự doanh' },
    foreign:     { api: 'ForeignMatch',          name: 'Nước ngoài' }
};

/**
 * Thống kê dòng tiền (khớp lệnh) Mua / Bán / Ròng cho MỘT nhóm NĐT, kèm
 * Top mã Mua ròng / Bán ròng trong phiên hôm nay.
 *
 * Net = foreignBuyValue − foreignSellValue (KHÔNG dùng foreignNetBuyValue/SellValue
 * vì đó là tổng gross theo từng mã). Đơn vị quy đổi: VND → ÷1e9 = tỷ.
 *
 * @param {string} key 'individual' | 'institution' | 'proprietary' | 'foreign'
 * @param {string} comGroupCode mã nhóm chỉ số ('VNINDEX' mặc định)
 */
async function getInvestorStatistic(key, comGroupCode = 'VNINDEX') {
    const t = INVESTOR_TYPES[key];
    if (!t) throw new Error('invalid investor type: ' + key);
    const url = `https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor`
        + `?language=vi&comGroupCode=${encodeURIComponent(comGroupCode)}&investorType=${t.api}`;
    const data = await fiinGet(url);
    const it = (data && data.items && data.items[0]) || {};

    const agg = (o) => o ? {
        buy: round1((o.foreignBuyValue || 0) / BILLION),
        sell: round1((o.foreignSellValue || 0) / BILLION),
        net: round1(((o.foreignBuyValue || 0) - (o.foreignSellValue || 0)) / BILLION)
    } : null;

    const perTicker = (((it.today && it.today.buy) || [])).map(s => ({
        ticker: s.ticker,
        net: round1(((s.foreignBuyValue || 0) - (s.foreignSellValue || 0)) / BILLION),
        percentChange: round1((s.percentPriceChange || 0) * 100),
        price: s.matchPrice || 0
    })).filter(s => s.ticker);

    const desc = [...perTicker].sort((a, b) => b.net - a.net);

    return {
        key,
        name: t.name,
        today: agg(it.today),
        oneWeek: agg(it.oneWeek),
        oneMonth: agg(it.oneMonth),
        topBuy: desc.filter(s => s.net > 0).slice(0, 10),
        topSell: desc.filter(s => s.net < 0).slice(-10).reverse()
    };
}

/**
 * Dòng tiền khớp ròng (GT, tỷ đồng) theo 4 nhóm NĐT cho MỘT mã, theo thời gian.
 * Nguồn: Fiintrade GetPriceData (wl-technical). Đã kiểm chứng: dùng MÃ CK trực tiếp
 * làm tham số Code (organCode trùng ticker với cổ phiếu niêm yết). PageSize phải đủ
 * lớn (60) — PageSize quá nhỏ/0 bị API từ chối 400.
 *
 * Tổ chức (TCTN) = -(Cá nhân + Tự doanh + Nước ngoài): thị trường khớp lệnh zero-sum;
 * field localInstitutional* của Fiintrade đã gộp tự doanh nên KHÔNG dùng trực tiếp
 * (đúng theo reference processApiData trong Apps Script).
 *
 * @param {string} ticker mã CK (vd 'HPG')
 * @param {string} frequency 'Daily' | 'Weekly' | 'Monthly' (mặc định 'Daily')
 * @returns {Promise<{ticker:string, frequency:string, points:Array<{date:string,close:number,percentChange:number,caNhan:number,toChuc:number,tuDoanh:number,nuocNgoai:number}>}>}
 */
const STOCK_FLOW_FREQ = ['Daily', 'Weekly', 'Monthly'];
const INDEX_CODES = new Set(['VNINDEX', 'VN30', 'HNXINDEX', 'UPCOMINDEX']);

async function getStockInvestorFlow(ticker, frequency = 'Daily') {
    const code = String(ticker || '').trim().toUpperCase();
    const freq = STOCK_FLOW_FREQ.includes(frequency) ? frequency : 'Daily';
    if (!code) return { ticker: code, frequency: freq, points: [] };
    // GetPriceData từ chối chỉ số (HTTP 400) → chặn sớm và báo lỗi rõ ràng.
    if (INDEX_CODES.has(code)) {
        throw new Error(`'${code}' là chỉ số — không hỗ trợ dòng tiền theo mã.`);
    }

    // Resolve organCode — một số mã (BSR→BSRC) cần mã nội bộ FIIN khác ticker.
    const organCode = await resolveOrganCode(code);
    const url = `https://wl-technical.fiintrade.vn/PriceData/GetPriceData`
        + `?language=vi&Code=${encodeURIComponent(organCode)}&Frequently=${encodeURIComponent(freq)}&Page=1&PageSize=60`;
    const data = await fiinGet(url);
    const items = (data && data.items) || [];
    if (!items.length) return { ticker: code, frequency: freq, points: [] };

    const points = items.map(it => {
        const caNhan    = ((it.localIndividualBuyMatchValue || 0)       - (it.localIndividualSellMatchValue || 0))       / BILLION;
        const tuDoanh   = ((it.proprietaryTotalMatchBuyTradeValue || 0) - (it.proprietaryTotalMatchSellTradeValue || 0)) / BILLION;
        const nuocNgoai = ((it.foreignBuyValueMatched || 0)            - (it.foreignSellValueMatched || 0))            / BILLION;
        const toChuc    = -(caNhan + tuDoanh + nuocNgoai);
        return {
            date: it.tradingDate ? String(it.tradingDate).slice(0, 10) : '',
            close: it.closeValue || 0,
            percentChange: round1((it.percentValueChange || 0) * 100),
            caNhan: round1(caNhan),
            toChuc: round1(toChuc),
            tuDoanh: round1(tuDoanh),
            nuocNgoai: round1(nuocNgoai)
        };
    });

    // Sắp xếp CŨ -> MỚI (chronological) để biểu đồ đường đọc đúng trái -> phải.
    // (API trả MỚI -> CŨ; date đã ở dạng yyyy-MM-dd nên so sánh chuỗi = so sánh thời gian.)
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    return { ticker: code, frequency: freq, points };
}

/**
 * Lấy dòng tiền ròng (TC+TD+NN) cho N ngày gần nhất của nhiều mã trong 1 ngành.
 * Gọi GetPriceData từng mã (1 request/mã, đã chứa 60 ngày) → lấy N ngày gần nhất.
 * Chạy batch song song (10 mã/lượt) để tối ưu tốc độ.
 *
 * @param {string[]} tickers danh sách mã trong ngành
 * @param {number} batchSize số request song song (mặc định 10)
 * @param {Function} onProgress callback({done, total, ticker})
 * @param {number} days số phiên gần nhất cần giữ (mặc định 1)
 * @returns {Promise<Array>} [{ticker, latest:{date,close,...,netSmart}, days:[{date,netSmart,...}], netSmartCum}]
 *                           netSmartCum = tổng netSmart N ngày (dùng sort top). days[] cũ→mới.
 */
async function getSectorTopStocksFlow(tickers, batchSize = 10, onProgress, days = 1) {
    const valid = (tickers || []).filter(t => t && !INDEX_CODES.has(t.toUpperCase()));
    const results = [];
    let done = 0;

    for (let i = 0; i < valid.length; i += batchSize) {
        const chunk = valid.slice(i, i + batchSize);
        const proms = chunk.map(t => getStockInvestorFlow(t, 'Daily').catch(() => ({ ticker: t, points: [] })));
        const responses = await Promise.all(proms);
        for (const r of responses) {
            const pts = r && r.points ? r.points : [];
            if (pts.length > 0) {
                // Lấy N ngày gần nhất (cũ → mới)
                const recent = pts.slice(-Math.max(1, days));
                const latest = recent[recent.length - 1];
                // Tổng cộng dồn netSmart + từng nhóm N ngày (để modal hiển thị tổng tuần/tháng)
                const sum = (key) => round1(recent.reduce((s, p) => s + (p[key] || 0), 0));
                const netSmartCum = round1(sum('toChuc') + sum('tuDoanh') + sum('nuocNgoai'));
                // Map per-day: mỗi ngày  object gọn
                const perDay = recent.map(p => ({
                    date: p.date,
                    netSmart: round1(p.toChuc + p.tuDoanh + p.nuocNgoai),
                    nuocNgoai: p.nuocNgoai,
                    toChuc: p.toChuc,
                    tuDoanh: p.tuDoanh
                }));
                results.push({
                    ticker: latest.ticker || r.ticker,
                    date: latest.date,
                    close: latest.close,
                    percentChange: latest.percentChange,
                    caNhan: latest.caNhan,
                    toChuc: latest.toChuc,
                    tuDoanh: latest.tuDoanh,
                    nuocNgoai: latest.nuocNgoai,
                    netSmart: round1(latest.toChuc + latest.tuDoanh + latest.nuocNgoai),
                    // Cum (tổng N phiên) cho cả 4 nhóm — modal multi-day hiển thị cum
                    netSmartCum,
                    nuocNgoaiCum: sum('nuocNgoai'),
                    toChucCum: sum('toChuc'),
                    tuDoanhCum: sum('tuDoanh'),
                    days: perDay
                });
            }
            done++;
            if (onProgress) onProgress({ done, total: valid.length, ticker: r.ticker });
        }
    }
    return results;
}

module.exports = {
    FII_HEADERS,
    fiinGet,
    getOrganCodeMap,
    resolveOrganCode,
    getSectorFlow,
    getMarketInvestorFlow,
    getForeignStatistic,
    getInvestorStatistic,
    getStockInvestorFlow,
    getSectorTopStocksFlow,
    INVESTOR_TYPES,
    cleanSectorName,
    round1
};
