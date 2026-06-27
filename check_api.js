const axios = require('axios');
(async () => {
    try {
        const url = "https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?timeRange=1&group=VNINDEX&language=vi";
        const res = await axios.get(url, {
            headers: {
                "Origin": "https://portal.fidt.vn",
                "Referer": "https://portal.fidt.vn/"
            }
        });
        if (res.data && res.data.items && res.data.items.length > 0) {
            console.log("Keys:", Object.keys(res.data.items[0]));
            // Also check for Institution fields
            const first = res.data.items[0];
            const institutionFields = Object.keys(first).filter(k => k.toLowerCase().includes('institution') || k.toLowerCase().includes('local'));
            console.log("Institution Fields:", institutionFields);
        } else {
            console.log("No data found");
        }
    } catch (e) { console.error(e.message); }
})();
