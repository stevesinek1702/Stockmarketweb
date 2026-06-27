const axios = require('axios');
(async () => {
    try {
        const url = "https://wl-market.fiintrade.vn/MoneyFlow/GetStatisticInvestor?timeRange=5&group=VNINDEX&language=vi";
        console.log("Calling:", url);
        const res = await axios.get(url, {
            headers: {
                "Origin": "https://portal.fidt.vn",
                "Referer": "https://portal.fidt.vn/"
            }
        });
        if (res.data && res.data.items && res.data.items.length > 0) {
            console.log("Keys:", Object.keys(res.data.items[0]));
            const first = res.data.items[0];
            const dealFields = Object.keys(first).filter(k => k.toLowerCase().includes('deal') || k.toLowerCase().includes('pt'));
            console.log("Deal Fields:", dealFields);
            const matchFields = Object.keys(first).filter(k => k.toLowerCase().includes('match'));
            console.log("Match Fields:", matchFields);
        } else {
            console.log("No data found. Response:", JSON.stringify(res.data).substring(0, 500));
        }
    } catch (e) { console.error(e.message); }
})();
