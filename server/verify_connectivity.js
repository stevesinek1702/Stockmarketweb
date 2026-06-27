require('dotenv').config();
const axios = require('axios');

const API_CONFIG = {
    fireant: {
        base: 'https://www.fireant.vn/api/Data',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    }
};

(async () => {
    console.log('🔍 Testing External API Connectivity...\n');

    // 1. Test Fireant (Basic Quotes)
    try {
        console.log('👉 Testing Fireant (Quotes)...');
        const fireantUrl = `${API_CONFIG.fireant.base}/Markets/Quotes?symbols=HPG`;
        const t0 = Date.now();
        const res = await axios.get(fireantUrl, { headers: API_CONFIG.fireant.headers, timeout: 5000 });
        const t1 = Date.now();
        console.log(`✅ Fireant OK (${t1 - t0}ms). Status: ${res.status}`);
        if (Array.isArray(res.data) && res.data.length > 0) {
            console.log(`   Sample Data: ${res.data[0].Symbol} - Price: ${res.data[0].PriceCurrent}`);
        } else {
            console.warn('   ⚠️ Response data empty or invalid format.');
        }
    } catch (e) {
        console.error(`❌ Fireant FAILED: ${e.message}`);
    }

})();
