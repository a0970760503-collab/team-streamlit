let currentTopic = '';
// 全域變數用以儲存從 JSON 讀取的數據與看盤資訊
let globalData = null;
let debateFinished = false;
let debateMessagePending = false;
let currentMarket = 'btcusdt';
let currentPeriod = 5;
let klineDataCache = [];
let klineLayout = {}; // 預設看盤商品代號
let activeDashboardView = 'home'; // 預設底層視圖：'home'（行情首頁）或 'chart'（詳細 K 線）
const LEARNING_PROGRESS_KEY = 'max-ai-learning-progress-v1';
const learningAnswers = { 1: 'USDT', 2: '1 天', 3: '先定風險上限' };
let learningProgress = new Set();

function selectAiMode(mode) {
    const selected = mode === 'ai' ? 'ai' : 'demo';
    sessionStorage.setItem('ai-experience-mode', selected);
    document.documentElement.dataset.aiMode = selected;
    const modal = document.getElementById('ai-mode-modal');
    if (modal) modal.style.display = 'none';
}

function aiModeEnabled() {
    return sessionStorage.getItem('ai-experience-mode') === 'ai';
}

// P10：資料來源可信度追蹤。任何降級（agent_report.json／mockData／盤口或 K 線 Mock）
// 都必須標記為非 live，並在畫面亮出警示橫幅，讓觀看者知道數值不是即時報價。
const PRICE_UNAVAILABLE = '--';
const degradedChannels = new Map(); // channel -> 降級原因

function markDataSource(channel, source, reason) {
    if (source === 'live') {
        degradedChannels.delete(channel);
    } else {
        degradedChannels.set(channel, reason || '資料來源不可用');
    }
    updateDataSourceBanner();
}

function isLiveDataSource(data) {
    return !!data && data.dataSource === 'live';
}

// 價格／漲跌顯示：非 live 或缺值時一律顯示 '--'，絕不補假數字
function formatPriceText(value, dataSource) {
    if (dataSource !== 'live' || value === null || value === undefined || value === '' || Number.isNaN(Number(value))) {
        return PRICE_UNAVAILABLE;
    }
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatChangeText(value, dataSource) {
    if (dataSource !== 'live' || value === null || value === undefined || value === '' || Number.isNaN(Number(value))) {
        return PRICE_UNAVAILABLE;
    }
    const num = Number(value);
    return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}

// 以原生 DOM 建立／更新警示橫幅（無任何函式庫）
function updateDataSourceBanner() {
    const host = document.querySelector('.phone-frame') || document.body;
    let banner = document.getElementById('data-source-banner');

    if (degradedChannels.size === 0) {
        if (banner) banner.style.display = 'none';
        return;
    }

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'data-source-banner';
        banner.setAttribute('role', 'alert');
        banner.style.position = 'relative'; // 改為 relative 以推開下方內容
        banner.style.flexShrink = '0';
        banner.style.zIndex = '2000';
        banner.style.padding = '8px 12px';
        banner.style.background = 'rgba(255, 0, 60, 0.92)';
        banner.style.color = '#fff';
        banner.style.fontSize = '11px';
        banner.style.fontWeight = 'bold';
        banner.style.lineHeight = '1.4';
        banner.style.textAlign = 'center';
        banner.style.letterSpacing = '0.3px';
        banner.style.boxShadow = '0 2px 12px rgba(255, 0, 60, 0.5)';
        
        const dashboard = document.querySelector('.phone-dashboard');
        if (dashboard) {
            dashboard.insertBefore(banner, dashboard.firstChild);
        } else {
            host.appendChild(banner);
        }
    }

    const reasons = Array.from(degradedChannels.entries())
        .map(([channel, reason]) => `${channel}: ${reason}`)
        .join('　/　');
    banner.textContent = `⚠ 資料來源異常：即時行情暫不可用，以下數值非即時報價（${reasons}）`;
    banner.style.display = 'block';
}

// 預設的 Mock 備用數據，若 Fetch API 讀取失敗時將自動採用此資料
const mockData = {
    technical_agent: {
        rsi: 28.5,
        signal: 'SELL',
        speech: '「我是技術分析師。目前 RSI 已經殺到了超賣區間的 28.5，均線死叉向下。短期在 96K 破位後，我認為下行空間依然被打開，在出現實質性築底訊號前，我強烈建議保持 SELL (平倉觀望)！」'
    },
    sentiment_agent: {
        fear_greed: 18,
        sentiment: 'BUY',
        sentiment_score: 85,
        speech: '「我是輿情情緒分析師。雖然盤面破位，但此時恐慌與貪婪指數已經跌入 18 的極度恐慌極值！歷史經驗表明散戶的情緒冰點往往是巨鯨掃貨的良機。社群上的看空聲浪已達極限，我偏向 BUY (防禦性買入)。」'
    },
    investment_committee: {
        technical_score: 20,
        sentiment_score: 85,
        risk_score: 30,
        behavior_score: 35,
        committee_score: 42.5,
        final_action: 'HOLD',
        risk_speech: '「我是風險控管師。技術面的破位直接威脅到本金安全，雖然情緒極度恐慌暗示有反彈的可能，但此時進場風報比極差。我們必須嚴格執行防守，目前不宜開倉。」',
        behavior_speech: '「我是投資人格分析師。分析過往交易紀錄，您在類似的大跌急跌行情中，極易因 FOMO 心理進行恐慌性割肉或盲目抄底，單次最大資金回撤曾高達 15%。我強烈主張中斷開倉衝動。」',
        chair_speech: '「我是委員會主席。感謝各位委員。技術面看空，情緒面看多，但考量到用戶激進的交易人格特質，目前風控紅線已亮起。本委員會最終裁決：HOLD (觀望防守)，強制保留 100% USDT 購買力。」'
    },
    // P10：Mock 情境不提供任何價格數值，一律顯示為不可用
    llm_input: { price_usd: null, change_24h: null }
};

// 實作資料讀取 (Fetch API)：優先連線 Java Spring Boot REST API，失敗時降級讀取 agent_report.json 或 Mock
// AWS deployment injects the API Gateway origin through config.js; local development uses same origin.
// config.js is normally written during deployment. The CloudFront fallback
// keeps an already-cached config.js from disconnecting community and AI calls.
const SERVERLESS_API_FALLBACK = 'https://mrfr4nlyfb.execute-api.us-west-2.amazonaws.com';
const configuredApiBaseUrl = String(window.APP_CONFIG?.apiBaseUrl || '').replace(/\/$/, '');
const apiBaseUrl = configuredApiBaseUrl || (location.hostname.endsWith('.cloudfront.net') ? SERVERLESS_API_FALLBACK : '');
const apiFetch = (path, options) => fetch(`${apiBaseUrl}${path}`, options);

async function fetchData() {
    try {
        // 優先嘗試向 Java / Python 後端 8080 埠請求最新行情與動態 Agent 分析
        const response = await apiFetch('/api/report');
        if (response.ok) {
            const apiData = await response.json();
            console.log('✅ 成功從後端 API 取得實時動態數據:', apiData);

            // 將 API 資料 Normalize 為原本 UI 期望的 mockData 格式，防止 Crash
            globalData = JSON.parse(JSON.stringify(mockData)); // 深拷貝為基底

            // P10：只有後端明示 dataSource === 'live' 才視為即時報價
            const live = apiData.dataSource === 'live'
                && apiData.currentPrice !== null && apiData.currentPrice !== undefined;
            globalData.dataSource = live ? 'live' : 'unavailable';
            globalData.currentPrice = live ? apiData.currentPrice : null;
            globalData.change24h = live ? apiData.change24h : null;
            globalData.llm_input = {
                price_usd: globalData.currentPrice,
                change_24h: globalData.change24h
            };
            markDataSource('即時報價', globalData.dataSource,
                apiData.priceError || apiData.error || '後端標記 dataSource=unavailable');

            // 對應 4 位 Agent 的資料
            if (apiData.debates && apiData.debates.length >= 4) {
                // 技術分析師
                globalData.technical_agent.speech = apiData.debates[0].text;
                globalData.technical_agent.signal = apiData.debates[0].signal || 'HOLD';
                globalData.technical_agent.rsi = parseFloat(apiData.debates[0].score || 50);
                globalData.investment_committee.technical_score = parseInt(apiData.debates[0].score || 50);

                // 風控長
                globalData.investment_committee.risk_speech = apiData.debates[1].text;
                globalData.investment_committee.risk_score = parseInt(apiData.debates[1].score || 50);

                // 情緒分析師
                globalData.sentiment_agent.speech = apiData.debates[2].text;
                globalData.sentiment_agent.sentiment = apiData.debates[2].signal || 'HOLD';
                globalData.sentiment_agent.sentiment_score = parseInt(apiData.debates[2].score || 50);
                globalData.sentiment_agent.fear_greed = parseInt(apiData.debates[2].score || 50);

                // 人格分析師
                globalData.investment_committee.behavior_speech = apiData.debates[3].text;
                globalData.investment_committee.behavior_score = parseInt(apiData.debates[3].score || 50);
            }

            // 委員會總決議
            if (apiData.committee) {
                const dec = apiData.committee.finalDecision || 'HOLD';
                globalData.investment_committee.final_action = dec.includes('BUY') ? 'BUY' : (dec.includes('SELL') ? 'SELL' : 'HOLD');
                globalData.investment_committee.committee_score = apiData.committee.confidenceScore || 50;

                // 清空預設的 chair_speech 讓 UI 自動利用 generateDynamicSpeech 動態生成
                globalData.investment_committee.chair_speech = "";
            }

        } else {
            throw new Error(`HTTP API 狀態碼: ${response.status}`);
        }
    } catch (error) {
        console.warn('連線 API 失敗，嘗試讀取本地 agent_report.json 或備用 mockData...', error.message);
        // P10：落到 agent_report.json 或 mockData 一律視為非 live，必須亮警示橫幅
        let fallbackLabel = '本地備用資料 (mockData)';
        try {
            const response = await fetch('agent_report.json');
            if (response.ok) {
                globalData = await response.json();
                fallbackLabel = '本地快照 (agent_report.json)';
            } else {
                globalData = JSON.parse(JSON.stringify(mockData));
            }
        } catch (e) {
            globalData = JSON.parse(JSON.stringify(mockData));
        }
        globalData.dataSource = 'unavailable';
        globalData.currentPrice = null;
        globalData.change24h = null;
        globalData.llm_input = { price_usd: null, change_24h: null };
        markDataSource('即時報價', 'unavailable', `${fallbackLabel}，非即時報價`);
    }

    // 讀取成功後，立即渲染與數據相關的 UI
    updateUIWithData(globalData);
}

// 監聽網頁載入，自動初始化所有資料與真實圖表
window.addEventListener('DOMContentLoaded', () => {
    loadLearningProgress();
    fetchData();
    showDashboardHomeView();
});

// 實作新聞讀取 API
async function fetchNews() {
    const newsContainer = document.getElementById('home-news-container');
    const phoneNewsContainer = document.getElementById('phone-news-list');

    const loadingHtml = `
        <div style="color:var(--text-muted); text-align:center; padding:10px;">
            <span class="typing-indicator" style="display:inline-block; margin-bottom:5px;"><span></span><span></span><span></span></span><br>
            載入即時快訊中...
        </div>
    `;
    if (newsContainer) newsContainer.innerHTML = loadingHtml;
    if (phoneNewsContainer) phoneNewsContainer.innerHTML = loadingHtml;

    try {
        const response = await apiFetch('/api/news?_t=' + new Date().getTime());
        if (response.ok) {
            const data = await response.json();
            const newsContainer = document.getElementById('home-news-container');
            const phoneNewsContainer = document.getElementById('phone-news-list');

            if (data.news && data.news.length > 0) {
                let html = '';
                data.news.forEach(item => {
                    // Try to format date
                    let dateStr = item.pubDate;
                    try {
                        const d = new Date(item.pubDate);
                        if (!isNaN(d)) dateStr = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    } catch(e) {}

                    html += `
                        <div style="padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <a href="${item.link}" target="_blank" style="color: var(--primary); text-decoration: none; font-weight: bold; display: block; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                ${item.title}
                            </a>
                            <span style="color: var(--text-muted); font-size: 9px;">${dateStr}</span>
                        </div>
                    `;
                });
                if (newsContainer) newsContainer.innerHTML = html;
                if (phoneNewsContainer) phoneNewsContainer.innerHTML = html;
            } else {
                const emptyHtml = '<div style="color:var(--text-muted); font-size:10px; text-align:center; padding:10px;">目前沒有綜合快訊。</div>';
                if (newsContainer) newsContainer.innerHTML = emptyHtml;
                if (phoneNewsContainer) phoneNewsContainer.innerHTML = emptyHtml;
            }
        } else {
            throw new Error(`API responded with status ${response.status}`);
        }
    } catch (e) {
        console.warn('載入新聞快訊失敗:', e);
        const errorHtml = '<div style="color:var(--text-muted); font-size:10px; text-align:center; padding:10px;">載入新聞失敗，請稍後再試。</div>';
        const newsContainer = document.getElementById('home-news-container');
        const phoneNewsContainer = document.getElementById('phone-news-list');
        if (newsContainer) newsContainer.innerHTML = errorHtml;
        if (phoneNewsContainer) phoneNewsContainer.innerHTML = errorHtml;
    }
}
// 前端獨立邏輯與動態拼接生成器
function generateDynamicSpeech(agent, data) {
    const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];

    if (agent === 'technical') {
        const rsi = data.technical_agent.rsi;
        const signal = data.technical_agent.signal;
        const ma5 = data.technical_agent.ma5;
        const ma20 = data.technical_agent.ma20;

        const openings = [
            `「從目前的 K 線結構和技術面指標來看，`,
            `「觀察 SOL 的即時技術走勢，`,
            `「針對目前的價格動量與趨勢，技術指標顯示：`
        ];

        let rsiText = '';
        if (rsi > 70) {
            rsiText = `目前 RSI 已經達到超買區間的 ${rsi}，多頭情緒極度亢奮，但需警戒隨時而來的修正壓力。`;
        } else if (rsi < 30) {
            rsiText = `目前 RSI 已經殺到超賣區間的 ${rsi}，短期價格有超跌跡象，技術上隨時可能觸發強彈。`;
        } else {
            rsiText = `目前 RSI 處於中性偏調整的 ${rsi} 水平，價格在區間震盪整理，尚未出現極端的超買或超賣。`;
        }

        let maText = '';
        if (ma5 !== undefined && ma20 !== undefined) {
            if (ma5 > ma20) {
                maText = `同時，5日均線 (${ma5}) 運行在20日均線 (${ma20}) 之上，金叉偏多格局暫未被破壞。`;
            } else if (ma5 < ma20) {
                maText = `同時，5日均線 (${ma5}) 跌破20日均線 (${ma20}) 形成死叉向下，空頭排列令短期承壓沉重。`;
            } else {
                maText = `同時，短期均線 MA5 與 MA20 交織纏繞，價格波動收斂，正等待方向突破。`;
            }
        } else {
            if (signal === 'BUY') {
                maText = `同時，均線系統呈黃金交叉，多頭結構維持良好。`;
            } else if (signal === 'SELL') {
                maText = `同時，短期均線死叉向下，上方壓力帶層層堆疊。`;
            } else {
                maText = `同時，均線糾結，短期內缺乏清晰的趨勢方向。`;
            }
        }

        let conclusion = '';
        if (signal === 'BUY') {
            conclusion = `綜上，我認為應該把握超跌反彈或強勢突破的機會，強烈建議執行 BUY 策略！」`;
        } else if (signal === 'SELL') {
            conclusion = `從風報比來看，當前風險遠大於收益，我建議保持 SELL 評級，平倉或減倉觀望！」`;
        } else {
            conclusion = `此處多空分歧加劇，不宜貿然押注，我建議採取 HOLD 策略，空手靜待市場走穩！」`;
        }

        return randomChoice(openings) + rsiText + maText + conclusion;
    }

    if (agent === 'sentiment') {
        const fearGreed = data.sentiment_agent.fear_greed;
        const sentiment = data.sentiment_agent.sentiment;

        const openings = [
            `「我是輿情與市場情緒分析師。`,
            `「從社群輿情和散戶情緒來看，`,
            `「輿情監測結果顯示，目前市場群眾的心理狀態非常微妙：`
        ];

        let fgText = '';
        if (fearGreed >= 70) {
            fgText = `當前 Fear & Greed 指數為 ${fearGreed}，市場處於貪婪狀態，散戶 FOMO 情緒再度被點燃。`;
        } else if (fearGreed <= 30) {
            fgText = `當前 Fear & Greed 指數已跌入 ${fearGreed} 的極度恐慌區，市場充斥悲觀氣氛，割肉盤不斷湧出。`;
        } else {
            fgText = `當前 Fear & Greed 指數為 ${fearGreed}，大眾情緒處於冷靜與觀望狀態，缺乏一致的共識。`;
        }

        let socialText = '';
        if (sentiment === 'Bullish' || sentiment === 'BUY') {
            socialText = `在 Twitter 和 Discord 等社群上，看多情緒依然高漲，討論熱度爆表，買盤支持強勁。`;
        } else if (sentiment === 'Bearish' || sentiment === 'SELL') {
            socialText = `社群看空聲浪鋪天蓋地，恐慌踩踏現象明顯，短期內缺乏增量資金入場。`;
        } else {
            socialText = `社群情緒目前多空平衡，交易者多以防守或短線套利為主，整體情緒較為溫和。`;
        }

        let conclusion = '';
        if (sentiment === 'Bullish' || sentiment === 'BUY') {
            conclusion = `眾人拾柴火焰高，在恐慌極值或強大共識支持下，我建議 BUY 偏多布局！」`;
        } else if (sentiment === 'Bearish' || sentiment === 'SELL') {
            conclusion = `在群眾恐慌踩踏結束前，我不建議盲目抄底，維持 SELL 偏空觀望建議！」`;
        } else {
            conclusion = `群眾看法極度分裂，情緒指標無指向，我認為在此區間 HOLD 觀望最為安全！」`;
        }

        return randomChoice(openings) + fgText + socialText + conclusion;
    }

    if (agent === 'risk') {
        const riskScore = data.investment_committee.risk_score;
        const action = data.investment_committee.final_action;

        const openings = [
            `「風控長報告：從整體市場的風報比與槓桿率來看，`,
            `「我是風險控管師。從資金安全和防禦優先的原則出發，`,
            `「風控評估指出，當前的帳戶水位與波動率特徵顯示：`
        ];

        let riskText = '';
        if (riskScore >= 70) {
            riskText = `目前的市場風險值高達 ${riskScore}，高槓桿清算地圖正在擴大，市場波動極為劇烈。`;
        } else if (riskScore <= 30) {
            riskText = `目前整體風險值僅有 ${riskScore}，市場下行空間有限，回撤風險完全處於安全範圍內。`;
        } else {
            riskText = `目前市場風險值為 ${riskScore}，波動率處於正常歷史均值，但上行與下行空間對稱。`;
        }

        let actionText = '';
        if (action === 'BUY') {
            actionText = `雖然有一定的波動風險，但風報比對多頭極具吸引力，若做好單筆損益比控制即可進場。`;
        } else if (action === 'SELL') {
            actionText = `此時多頭部位將暴露在巨大的未知風險下，本金防禦高於一切，必須執行平倉避險。`;
        } else {
            actionText = `在此水位頻繁開倉沒有利潤空間，反而會耗損手續費，防守是保全本金的最佳策略。`;
        }

        let conclusion = '';
        if (action === 'BUY') {
            conclusion = `風控裁決：允許以低倉位執行 BUY，但必須严格設定保護性止損！」`;
        } else if (action === 'SELL') {
            conclusion = `風控裁決：強制執行 SELL (平倉或減倉) 防守，切勿盲目扛單！」`;
        } else {
            conclusion = `風控裁決：維持 HOLD 觀望，暫停新的開倉操作，保留最大購買力！」`;
        }

        return randomChoice(openings) + riskText + actionText + conclusion;
    }

    if (agent === 'behavior') {
        const behaviorScore = data.investment_committee.behavior_score;
        const action = data.investment_committee.final_action;

        const openings = [
            `「我是行為人格分析師。結合用戶過往的交易行為歷史，`,
            `「從用戶的交易心理與人格特徵進行診斷：`,
            `「行為基因監測指出，在當前市場波動下，用戶非常容易產生情緒偏差：`
        ];

        let behavText = '';
        if (behaviorScore >= 60) {
            behavText = `用戶的行為偏差分數為 ${behaviorScore} 分，極易在類似的極端行情中誘發 FOMO 追高或 Tilt (心態崩潰) 割肉。`;
        } else if (behaviorScore <= 30) {
            behavText = `用戶目前的紀律性評估為 ${behaviorScore} 分，表現得非常冷靜，不易受到短期價格波動的雜訊干擾。`;
        } else {
            behavText = `用戶的行為分數為 ${behaviorScore} 分，雖然大體保持理性，但連續虧損時容易產生報復性交易的傾向。`;
        }

        let actionText = '';
        if (action === 'BUY') {
            actionText = `此時買入雖符合數據，但必須遵循計畫建倉，避免因一時暴利幻想而重倉梭哈。`;
        } else if (action === 'SELL') {
            actionText = `當前急跌容易觸發恐慌割肉或死扛到底的頑固心理，過往此類衝動曾造成單次高達 15% 的重度回撤。`;
        } else {
            actionText = `此時 HOLD 的建議旨在幫助用戶阻斷無意義的頻繁操作，戒掉手癢的衝動交易毛病。`;
        }

        let conclusion = '';
        if (action === 'BUY') {
            conclusion = `我建議：分批佈局 BUY，嚴格遵守預設交易計劃，防止追高情緒失控！」`;
        } else if (action === 'SELL') {
            conclusion = `我強烈建議：堅決執行 SELL，切斷不切實際的幻想，阻斷心態失衡！」`;
        } else {
            conclusion = `我建議：執行 HOLD 觀望，暫時關閉交易界面，強迫自己進入冷靜期！」`;
        }

        return randomChoice(openings) + behavText + actionText + conclusion;
    }

    if (agent === 'chair') {
        const tech = data.investment_committee.technical_score;
        const sent = data.investment_committee.sentiment_score;
        const risk = data.investment_committee.risk_score;
        const behav = data.investment_committee.behavior_score;
        const score = data.investment_committee.committee_score;
        const action = data.investment_committee.final_action;
        const source = data.dataSource;
        const priceText = formatPriceText(data.llm_input && data.llm_input.price_usd, source);
        const changeText = formatChangeText(data.llm_input && data.llm_input.change_24h, source);

        const openings = [
            `「我是委員會主席。感謝各位委員的精彩陳述。`,
            `「投資委員會最終決議已出爐。綜合考量各維度數據：`,
            `「本閉門會議圓滿結束，現將各項量化指標總結如下：`
        ];

        const priceSummary = priceText === PRICE_UNAVAILABLE
            ? `SOL 即時報價目前無法取得（資料來源異常，本次未使用任何替代價格）。`
            : `當前 SOL 市場報價為 $${priceText} (24小時變動: ${changeText})。`;
        const summary = `${priceSummary}技術指標得分 ${tech}，情緒指數得分 ${sent}，風控長評分 ${risk} 分，人格特質偏離度 ${behav} 分。綜合加權得分為 ${score} 分。`;

        let verdict = '';
        if (action === 'BUY') {
            verdict = `目前市場多頭力量強勁且情緒共識達成。本委員會最終決議：執行 BUY (買入)！請引導用戶分批建倉並設置止損。`;
        } else if (action === 'SELL') {
            verdict = `考量到技術面破位、恐慌踩踏以及用戶的高回撤交易歷史，若繼續持倉風險極大。本委員會最終決議：執行 SELL (平倉避險)！請立即減倉退回安全水位。`;
        } else {
            verdict = `當前市場多空分歧巨大，且交易性價比極低，此處盲目交易得不償失。本委員會最終決議：執行 HOLD (觀望防守)！強制保留 100% 現金購買力，靜待市場築底。`;
        }

        return randomChoice(openings) + summary + verdict;
    }

    return '';
}

let debateHistory = [];
let latestChairDecision = { summary: '', action: 'HOLD' };
let latestCommitteeRound = {};
let pendingCommitteePrompt = null;

// 展示模式採用固定劇本；使用者仍可在下方「加入討論」提出自己的觀點。
const DEMO_COMMITTEE_SCRIPT = [
    { agent: 'tech', icon: '📈', name: '技術分析委員', color: 'var(--primary)', text: '【劇本展示】第一輪觀察：先確認價格趨勢、成交量與關鍵支撐／壓力區是否一致。本展示只說明研究流程，不提供買賣指令。' },
    { agent: 'risk', icon: '🛡️', name: '風險管理委員', color: 'var(--warning)', text: '【劇本展示】風險評估：加密資產波動可能突然擴大；任何情境都應先設定可承受損失與資金上限，再討論後續策略。' },
    { agent: 'sent', icon: '🌐', name: '市場情緒委員', color: 'var(--success)', text: '【劇本展示】情緒觀察：短期訊息容易放大追高或恐慌。委員會會把市場情緒當成參考，而不是單一決策依據。' },
    { agent: 'behav', icon: '🧠', name: '行為觀察委員', color: 'var(--secondary)', text: '【劇本展示】行為提醒：在快速波動時先停下來檢查計畫，避免因 FOMO 或恐慌而偏離原本的風險規則。' },
    { agent: 'chair', icon: '👑', name: '主席委員', color: '#ffd700', text: '【劇本展示】主席結論：目前採取 HOLD（觀望），等待資料與風險條件更明確。歡迎按「加入討論」提出你的觀點，委員會會以展示回覆方式記錄。' }
];

function getScriptLines() {
    return DEMO_COMMITTEE_SCRIPT.map(line => ({ ...line }));
}

async function renderChatMessage(line) {
    const chatBox = document.getElementById('debate-messages-container');
    const typingId = 'typing-' + Date.now() + Math.random().toString(36).substr(2, 9);

    if (line.type === 'sys') {
        chatBox.insertAdjacentHTML('beforeend', `<div class="sys-msg"><span>${line.text}</span></div>`);
        chatBox.scrollTop = chatBox.scrollHeight;
        await new Promise(r => setTimeout(r, 600));
        return;
    }

    const typingHtml = `<div class="msg-block" id="${typingId}"><div class="avatar ${line.agent || 'tech'}">${line.icon || '⏱️'}</div><div class="msg-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div></div>`;
    chatBox.insertAdjacentHTML('beforeend', typingHtml);
    chatBox.scrollTop = chatBox.scrollHeight;

    const delay = Math.max(1000, (line.text || "").length * 15);
    await new Promise(r => setTimeout(r, delay));

    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    const msgHtml = `
    <div class="msg-block">
        <div class="avatar ${line.agent}">${line.icon}</div>
        <div class="msg-content">
            <div class="msg-header"><span class="agent-name" style="color:${line.color}">${line.name}</span></div>
            <div class="msg-bubble">${line.text}</div>
        </div>
    </div>`;
    chatBox.insertAdjacentHTML('beforeend', msgHtml);
    chatBox.scrollTop = chatBox.scrollHeight;
    await new Promise(r => setTimeout(r, 300));
}

async function renderToolUseStatus(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return;
    const labels = {
        get_max_ticker: 'MAX 即時報價',
        get_technical_snapshot: 'K 線技術摘要',
        get_crypto_news: '加密快訊'
    };
    const used = [...new Set(toolCalls)].map(name => labels[name] || name).join('、');
    await renderChatMessage({ type: 'sys', text: `🧰 模式 B｜AI 委員會自主使用研究工具：${used}` });
}

function debateHistoryForApi() {
    return debateHistory.slice(-8).map(item => ({
        name: String(item.name || '委員').slice(0, 40),
        text: String(item.text || '').slice(0, 500),
        role: item.role === 'user' ? 'user' : 'agent'
    })).filter(item => item.text);
}

function researchAction(value) {
    const action = String(value || '').toUpperCase();
    return ['BUY', 'SELL', 'HOLD'].includes(action) ? action : 'HOLD';
}

function updateCommitteeSummary(data, chair) {
    const debates = Array.isArray(data?.debates) ? data.debates : [];
    const findText = agent => debates.find(item => item.agent === agent)?.text || '本輪未取得該委員的研究摘要。';
    const fields = { tech: 'summary-tech', risk: 'summary-risk', sent: 'summary-sent', behav: 'summary-behav' };
    Object.entries(fields).forEach(([agent, id]) => {
        const element = document.getElementById(id);
        if (element) element.textContent = findText(agent);
    });
    const summary = document.getElementById('chair-summary-content');
    if (summary) summary.textContent = chair?.text || '主席統整內容尚未完成。';
    const action = document.getElementById('summary-action');
    if (action) action.textContent = `研究決策：${researchAction(data?.final_action)}`;
    latestCommitteeRound = { debates, chair: chair?.text || '', action: researchAction(data?.final_action) };
}

async function renderChairDecision(data) {
    const chair = Array.isArray(data.debates)
        ? data.debates.find(reply => reply.agent === 'chair' && reply.text)
        : null;
    if (!chair) throw new Error('主席統整內容不完整。');

    await renderChatMessage({ type: 'sys', text: '⚖️ 四位委員發言完成，主席正在協調共識與分歧…' });
    debateHistory.push({ name: chair.name, text: chair.text, role: 'agent' });
    await renderChatMessage(chair);
    latestChairDecision = { summary: chair.text, action: researchAction(data.final_action) };
    updateCommitteeSummary(data, chair);
    if (!globalData) globalData = JSON.parse(JSON.stringify(mockData));
    globalData.investment_committee = {
        ...(globalData.investment_committee || {}),
        final_action: latestChairDecision.action,
        chair_summary: latestChairDecision.summary
    };
    updateUIWithData(globalData);
}

async function startAiDebate(initialUserText = null) {
    nav('page1');
    document.getElementById('tab-btn-debate').style.display = 'block';
    switchTab('debate');
    const chatBox = document.getElementById('debate-messages-container');
    const actions = document.getElementById('decision-btn-area');
    if (!chatBox || !actions) return;
    const systemNotice = document.getElementById('debate-sys-msg');
    if (systemNotice) systemNotice.innerHTML = '<span>🧰 模式 B：AI 委員會可自主呼叫公開研究工具</span>';
    chatBox.replaceChildren();
    actions.style.display = 'none';
    debateFinished = false;
    debateHistory = [];
    latestChairDecision = { summary: '', action: 'HOLD' };
    latestCommitteeRound = {};

    const prompt = String(initialUserText || `請以繁體中文就 ${currentTopic || currentMarket.toUpperCase()} 說明目前可觀察的市場資訊、主要不確定性與研究重點。內容僅供教育與研究參考，不構成投資建議。`).trim();
    pendingCommitteePrompt = null;
    debateHistory.push({ name: '使用者', text: prompt, role: 'user' });
    await renderChatMessage({ agent: 'user', icon: '🗣️', name: '使用者', color: '#fff', text: prompt });
    try {
        const response = await apiFetch('/api/debate-message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market: currentMarket, message: prompt, discussionHistory: debateHistoryForApi() })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'AI 委員會暫時無法回應。');
        const replies = Array.isArray(data.debates) ? data.debates.filter(reply => reply.agent !== 'chair') : [];
        if (replies.length !== 4) throw new Error('四位委員的辯論內容不完整。');
        await renderToolUseStatus(data.toolCalls);
        for (const reply of replies) {
            debateHistory.push({ name: reply.name, text: reply.text, role: 'agent' });
            await renderChatMessage(reply);
        }
        await renderChairDecision(data);
    } catch (error) {
        await renderChatMessage({ type: 'sys', text: `AI 委員會暫時無法回應：${error.message}。你仍可結束本次討論，系統會標示為未完成的研究紀錄。` });
    } finally {
        debateFinished = true;
        actions.style.display = 'flex';
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

async function startDebate(initialUserText = null) {
    const committeePrompt = initialUserText || pendingCommitteePrompt;
    if (aiModeEnabled()) return startAiDebate(committeePrompt);
    // 顯示 Tab 並且切換過去
    document.getElementById('tab-btn-debate').style.display = 'block';
    switchTab('debate');

    if (debateFinished) {
        document.getElementById('decision-btn-area').style.display = 'flex';
        return;
    }

    // 設定標題，讓用戶知道當前討論的幣種
    document.getElementById('debate-sys-msg').innerHTML = `<span>🚨 系統警報：已針對 ${currentTopic || currentMarket} 啟動緊急辯論會議</span>`;


    const chatBox = document.getElementById('debate-messages-container');
    document.getElementById('decision-btn-area').style.display = 'none';

    debateHistory = [];

    if (initialUserText) {
        // 將使用者輸入保留為討論背景，接著播放展示劇本。
        debateHistory.push({ name: "人類用戶", text: initialUserText, role: "user" });
        await renderChatMessage({ agent: 'chair', icon: '👤', name: '人類用戶', color: '#fff', text: initialUserText });
    }

    // 不論由按鈕或對話助理開啟，均播放固定展示劇本。
    const scriptLines = getScriptLines();
    for (const line of scriptLines) {
        debateHistory.push({ name: line.name, text: line.text, role: "agent" });
        await renderChatMessage(line);
    }
    const scriptedChair = scriptLines.find(line => line.agent === 'chair');
    if (scriptedChair) {
        updateCommitteeSummary({ debates: scriptLines, final_action: 'HOLD' }, scriptedChair);
        latestChairDecision = { summary: scriptedChair.text, action: 'HOLD' };
    }

    debateFinished = true;
    setTimeout(() => {
        document.getElementById('decision-btn-area').style.display = 'flex';
        const debateTab = document.getElementById('debate-chat-box');
        debateTab.scrollTop = debateTab.scrollHeight;
    }, 400);
}

function toggleDebateInput() {
    document.getElementById('debate-action-btns').style.display = 'none';
    document.getElementById('debate-input-area').style.display = 'flex';
    document.getElementById('debate-input').focus();
}

async function endAiDebate() {
    const actions = document.getElementById('decision-btn-area');
    if (actions) actions.style.display = 'none';
    await renderChatMessage({ type: 'sys', text: '✅ 主席結論已產出，正在帶入主席統整資料頁…' });
    debateFinished = true;
    nav('page-summary');
}

async function sendDebateMsg() {
    const input = document.getElementById('debate-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    document.getElementById('debate-input-area').style.display = 'none';

    // Add user message to UI and history
    debateHistory.push({ name: "人類用戶", text: text, role: "user" });
    await renderChatMessage({ agent: 'chair', icon: '👤', name: '人類用戶', color: '#fff', text: text });

    // Call backend to get AI responses
    try {
        const response = await apiFetch('/api/debate-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market: currentMarket, message: text, discussionHistory: debateHistoryForApi() })
        });
        const resData = await response.json();

        if (resData && resData.debates) {
            await renderToolUseStatus(resData.toolCalls);
            for (let reply of resData.debates.filter(reply => reply.agent !== 'chair')) {
                debateHistory.push({ name: reply.name, text: reply.text, role: "agent" });
                await renderChatMessage(reply);
            }
            await renderChairDecision(resData);
        }
    } catch (e) {
        console.error("Chat Debate Error:", e);
        await renderChatMessage({ type: 'sys', text: `連線異常: ${e}` });
    }

    document.getElementById('debate-action-btns').style.display = 'flex';
}

async function endDebate() {
    if (aiModeEnabled()) return endAiDebate();
    document.getElementById('decision-btn-area').style.display = 'none';
    await renderChatMessage({ type: 'sys', text: '✅ 主席已暫停辯論，正在帶入統整資料頁…' });
    debateFinished = true;
    nav('page-summary');
}

async function loadDecisionBacktest() {
    const state = document.getElementById('backtest-state');
    const returns = document.getElementById('backtest-return');
    const risk = document.getElementById('backtest-risk');
    const note = document.getElementById('backtest-note');
    if (!state || !returns || !risk || !note) return;
    const action = (globalData?.investment_committee?.final_action || 'HOLD').toUpperCase();
    state.textContent = 'MAX 歷史 K 線計算中…';
    returns.textContent = '--';
    risk.textContent = '--';
    try {
        const response = await apiFetch(`/api/backtest?market=${encodeURIComponent(currentMarket || 'btcusdt')}&action=${encodeURIComponent(action)}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '回測資料暫不可用');
        const sign = value => `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
        state.textContent = `${result.action}｜${result.candles} 根 ${result.periodMinutes} 分 K 線`;
        state.style.color = Number(result.strategyReturnPct) >= 0 ? 'var(--success)' : 'var(--danger)';
        returns.textContent = `${sign(result.strategyReturnPct)} ／ ${sign(result.benchmarkReturnPct)}`;
        risk.textContent = `${Number(result.maxDrawdownPct).toFixed(2)}% ／ ${Number(result.hitRatePct).toFixed(1)}%`;
        note.textContent = result.disclaimer || '教育用歷史模擬，不代表未來表現。';
    } catch (error) {
        state.textContent = '回測暫不可用';
        state.style.color = 'var(--danger)';
        note.textContent = error.message || '請稍後再試。';
    }
}

// 動態更新投票與決策畫面 (Page 3 & Page 4 & Page 5)
function updateUIWithData(data) {
    if (!data) return;

    const action = data.investment_committee.final_action;

    // --- Page 3: 投票結果綁定 ---
    const voteResultEl = document.getElementById('final-action-p3');
    const voteDescEl = document.getElementById('final-desc-p3');
    const voteCircleEl = document.getElementById('vote-circle-p3');

    if (voteResultEl) {
        voteResultEl.innerText = action;
        // 根據結論設定相應顏色
        if (action === 'BUY') {
            voteResultEl.style.color = 'var(--success)';
            voteResultEl.style.textShadow = '0 0 10px var(--success)';
            if (voteDescEl) voteDescEl.innerText = '建議買入';
            if (voteCircleEl) {
                voteCircleEl.style.border = '4px solid var(--success)';
                voteCircleEl.style.boxShadow = '0 0 30px rgba(57, 255, 20, 0.2)';
            }
        } else if (action === 'SELL') {
            voteResultEl.style.color = 'var(--danger)';
            voteResultEl.style.textShadow = '0 0 10px var(--danger)';
            if (voteDescEl) voteDescEl.innerText = '平倉避險';
            if (voteCircleEl) {
                voteCircleEl.style.border = '4px solid var(--danger)';
                voteCircleEl.style.boxShadow = '0 0 30px rgba(255, 0, 60, 0.2)';
            }
        } else {
            voteResultEl.style.color = 'var(--warning)';
            voteResultEl.style.textShadow = '0 0 10px var(--warning)';
            if (voteDescEl) voteDescEl.innerText = '觀望防守';
            if (voteCircleEl) {
                voteCircleEl.style.border = '4px solid var(--warning)';
                voteCircleEl.style.boxShadow = '0 0 30px rgba(255, 215, 0, 0.2)';
            }
        }
    }

    // 更新 Page 3 各項代理人分數與進度條長度
    const scores = data.investment_committee;

    // 1. 人格分析 (behavior_score)
    const behavText = document.getElementById('score-behav-text');
    const behavBar = document.getElementById('score-behav-bar');
    if (behavText) behavText.innerText = `${scores.behavior_score} 分 (HOLD)`;
    if (behavBar) behavBar.style.width = `${scores.behavior_score}%`;

    // 2. 風險控制 (risk_score)
    const riskText = document.getElementById('score-risk-text');
    const riskBar = document.getElementById('score-risk-bar');
    if (riskText) riskText.innerText = `${scores.risk_score} 分 (HOLD)`;
    if (riskBar) riskBar.style.width = `${scores.risk_score}%`;

    // 3. 技術分析 (technical_score)
    const techText = document.getElementById('score-tech-text');
    const techBar = document.getElementById('score-tech-bar');
    if (techText) {
        techText.innerText = `${scores.technical_score} 分 (${data.technical_agent.signal})`;
        techText.style.color = data.technical_agent.signal === 'BUY' ? 'var(--success)' : data.technical_agent.signal === 'SELL' ? 'var(--danger)' : 'var(--warning)';
    }
    if (techBar) {
        techBar.style.width = `${scores.technical_score}%`;
        techBar.style.background = data.technical_agent.signal === 'BUY' ? 'var(--success)' : data.technical_agent.signal === 'SELL' ? 'var(--danger)' : 'var(--warning)';
    }

    // 4. 輿情情緒 (sentiment_score)
    const sentText = document.getElementById('score-sent-text');
    const sentBar = document.getElementById('score-sent-bar');
    if (sentText) {
        sentText.innerText = `${scores.sentiment_score} 分 (${data.sentiment_agent.sentiment})`;
        sentText.style.color = data.sentiment_agent.sentiment === 'BUY' ? 'var(--success)' : data.sentiment_agent.sentiment === 'SELL' ? 'var(--danger)' : 'var(--warning)';
    }
    if (sentBar) {
        sentBar.style.width = `${scores.sentiment_score}%`;
        sentBar.style.background = data.sentiment_agent.sentiment === 'BUY' ? 'var(--success)' : data.sentiment_agent.sentiment === 'SELL' ? 'var(--danger)' : 'var(--warning)';
    }


    // --- Page 4: 策略建議與圓餅圖 ---
    const pieInnerEl = document.getElementById('pie-inner-p4');
    const pieChartEl = document.getElementById('pie-chart-p4');
    const allocListEl = document.getElementById('alloc-list-p4');
    const allocSummaryEl = document.getElementById('alloc-summary-p4');

    if (action === 'BUY') {
        if (pieInnerEl) pieInnerEl.innerText = '80% BTC / 20% Cash';
        if (pieChartEl) pieChartEl.style.background = 'conic-gradient(var(--primary) 0% 80%, #333 80% 100%)';
        if (allocListEl) {
            allocListEl.innerHTML = `
                <div class="alloc-item"><div class="dot" style="background:var(--primary)"></div>BTC (80%) - 建議分批買入</div>
                <div class="alloc-item"><div class="dot" style="background:#333"></div>USDT (20%) - 保留部分現金</div>
            `;
        }
        if (allocSummaryEl) {
            allocSummaryEl.innerHTML = `
                💡 <b>個人化防控總結：</b><br>
                技術指標與輿情情緒發出強烈買入信號（輿情情緒分數為 ${scores.sentiment_score} 分）。考量到您的交易基因與大盤回撤，委員會本次決議建議適度配置 80% 倉位進行分批抄底。<br><br>
                <b>本次決議：分批買入 (BUY)，保留 20% 流動性。</b>
            `;
        }
    } else if (action === 'SELL') {
        if (pieInnerEl) pieInnerEl.innerText = '100% 現金 (USDT)';
        if (pieChartEl) pieChartEl.style.background = 'conic-gradient(var(--danger) 0% 100%)';
        if (allocListEl) {
            allocListEl.innerHTML = `
                <div class="alloc-item"><div class="dot" style="background:var(--danger)"></div>USDT (100%) - 建議全數平倉避險</div>
                <div class="alloc-item" style="color:var(--text-muted);"><div class="dot" style="background:transparent; border:1px solid #333;"></div>BTC (0%) - 暫停所有買入</div>
            `;
        }
        if (allocSummaryEl) {
            allocSummaryEl.innerHTML = `
                💡 <b>個人化防控總結：</b><br>
                技術分析指標破位下行（技術評分僅 ${scores.technical_score} 分）。為避免您在當前反轉暴跌行情中產生 FOMO 性重倉操作而導致大幅資金回撤，建議 100% 避險為 USDT。<br><br>
                <b>本次決議：全數賣出平倉 (SELL)，100% 避險。</b>
            `;
        }
    } else {
        // HOLD
        if (pieInnerEl) pieInnerEl.innerText = '100% 現金 (USDT)';
        if (pieChartEl) pieChartEl.style.background = 'conic-gradient(#333 0% 100%)';
        if (allocListEl) {
            allocListEl.innerHTML = `
                <div class="alloc-item"><div class="dot" style="background:#333"></div>USDT (100%) - 強制空手觀望</div>
                <div class="alloc-item" style="color:var(--text-muted);"><div class="dot" style="background:transparent; border:1px solid #333;"></div>BTC (0%) - 暫停所有交易</div>
            `;
        }
        if (allocSummaryEl) {
            allocSummaryEl.innerHTML = `
                💡 <b>個人化防控總結：</b><br>
                技術面與情緒面出現極端分歧（技術評分為 ${scores.technical_score}分，情緒評分為 ${scores.sentiment_score}分）。考量您過去在類似的反轉行情中，極易因 FOMO 觸發過度交易，並曾造成單次 15% 的嚴重虧損。<br><br>
                <b>本次決議：強制中斷交易衝動，保留 100% 購買力以保全本金。</b>
            `;
        }
    }

    // --- Page 5: 執行下單綁定 ---
    const orderActionEl = document.getElementById('order-action-p5');
    const orderEstimateEl = document.getElementById('order-estimate-p5');
    const orderLockEl = document.getElementById('order-lock-p5');
    const orderBtnEl = document.getElementById('order-btn-p5');
    const successDescEl = document.getElementById('success-desc-p5');

    if (action === 'BUY') {
        if (orderActionEl) orderActionEl.innerHTML = '<span style="color:var(--success)">建倉 BTC 部位 (買入)</span>';
        if (orderEstimateEl) orderEstimateEl.innerText = '消耗約 4,192 USDT (佔 80% 倉位)';
        if (orderLockEl) orderLockEl.innerHTML = '<span style="color:var(--primary)">嚴格遵守分批進場原則</span>';
        if (orderBtnEl) orderBtnEl.innerText = '🔒 點擊確認：一鍵買入 80% 倉位';
        if (successDescEl) successDescEl.innerText = '已透過 MAX API 完成限價/市價分批建倉委託，部位已進入安全監控水位。';
    } else if (action === 'SELL') {
        if (orderActionEl) orderActionEl.innerHTML = '<span style="color:var(--danger)">清除現有部位 (平倉)</span>';
        if (orderEstimateEl) orderEstimateEl.innerText = '換回約 5,240 USDT (全數平倉)';
        if (orderLockEl) orderLockEl.innerHTML = '<span style="color:var(--secondary)">24小時內暫停開倉建議</span>';
        if (orderBtnEl) orderBtnEl.innerText = '🔒 點擊確認：一鍵平倉轉為避險';
        if (successDescEl) successDescEl.innerText = '已透過 MAX API 完成平倉，資產已進入安全水位。';
    } else {
        // HOLD
        if (orderActionEl) orderActionEl.innerHTML = '<span style="color:var(--warning)">空手觀望 (不變動)</span>';
        if (orderEstimateEl) orderEstimateEl.innerText = '- (無需交易)';
        if (orderLockEl) orderLockEl.innerHTML = '<span style="color:var(--secondary)">持續監控市場關鍵支撐位</span>';
        if (orderBtnEl) orderBtnEl.innerText = '🔒 點擊確認：維持觀望狀態';
        if (successDescEl) successDescEl.innerText = '已確認不變動倉位，持續保持安全的水位並監控市場。';
    }
}

// 執行下單按鈕觸發：雙向數據流 API 串接
async function executeOrder() {
    // The AWS deployment intentionally does not expose a real order endpoint.
    const btnEl = document.getElementById('order-btn-p5');
    const descEl = document.getElementById('success-desc-p5');
    if (btnEl) btnEl.innerText = '🧪 已完成模擬下單（未送出真實委託）';
    if (descEl) descEl.textContent = '這是公開展示網站的模擬交易流程；系統不會儲存或使用任何 MAX 交易金鑰，也不會送出委託。';
    document.getElementById('success').style.display = 'flex';
}

function appendDebateMessage(agent, icon, name, color, text) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    const safeText = escapeClaudeHtml(text).replace(/\n/g, '<br>');
    chatBox.insertAdjacentHTML('beforeend', `
        <div class="msg-block">
            <div class="avatar ${agent}">${icon}</div>
            <div class="msg-content">
                <div class="msg-header"><span class="agent-name" style="color:${color}">${name}</span></div>
                <div class="msg-bubble">${safeText}</div>
            </div>
        </div>`);
    chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendDebateMessage() {
    const input = document.getElementById('debate-input');
    const button = document.getElementById('debate-send-btn');
    if (!input || debateMessagePending) return;
    const message = input.value.trim();
    if (!message) return;

    debateMessagePending = true;
    input.value = '';
    input.disabled = true;
    if (button) { button.disabled = true; button.textContent = '討論中…'; }
    appendDebateMessage('behav', '🗣️', '您', 'var(--text-main)', message);

    try {
        const response = await apiFetch('/api/debate-message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market: currentMarket, message })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '委員會暫時無法回應。');
        const replies = payload.replies || {};
        appendDebateMessage('tech', '📈', '技術分析委員', 'var(--primary)', replies.technical || '我會把您的觀點納入技術條件的追蹤。');
        appendDebateMessage('risk', '🛡️', '風險管理委員', 'var(--warning)', replies.risk || '我會依您的風險界線重新檢視情境。');
        appendDebateMessage('chair', '👑', '主席委員', '#ffd700', replies.chair || '已記錄您的意見，僅作研究討論，不構成交易指示。');
    } catch (error) {
        appendDebateMessage('chair', '👑', '主席委員', '#ffd700', error.message || '目前無法取得回應，請稍後再試。');
    } finally {
        debateMessagePending = false;
        input.disabled = false;
        input.focus();
        if (button) { button.disabled = false; button.textContent = '加入'; }
    }
}

// 頁面導航控制
function nav(pageId) {
    const pages = document.querySelectorAll('.page');
    pages.forEach(p => p.classList.remove('active'));

    const targetPage = document.getElementById(pageId);
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // 動態更新導航列狀態與顏色，提升科技儀式感
    const statusEl = document.getElementById('nav-status');
    const dotEl = document.getElementById('nav-dot');
    if (statusEl && dotEl) {
        if (pageId === 'page1') {
            statusEl.innerText = '待命狀態';
            statusEl.style.color = 'var(--text-muted)';
            dotEl.style.background = 'var(--success)';
            dotEl.style.boxShadow = '0 0 8px var(--success)';
        } else if (pageId === 'page2') {
            statusEl.innerText = '解析基因中';
            statusEl.style.color = 'var(--primary)';
            dotEl.style.background = 'var(--primary)';
            dotEl.style.boxShadow = '0 0 8px var(--primary)';
        } else if (pageId === 'page3') {
            statusEl.innerText = '委員辯論中';
            statusEl.style.color = 'var(--danger)';
            dotEl.style.background = 'var(--danger)';
            dotEl.style.boxShadow = '0 0 8px var(--danger)';
        } else if (pageId === 'page-summary') {
            statusEl.innerText = '主席統整中';
            statusEl.style.color = 'var(--primary)';
            dotEl.style.background = 'var(--primary)';
            dotEl.style.boxShadow = '0 0 8px var(--primary)';
        } else if (pageId === 'page4') {
            statusEl.innerText = '決議已產出';
            statusEl.style.color = 'var(--warning)';
            dotEl.style.background = 'var(--warning)';
            dotEl.style.boxShadow = '0 0 8px var(--warning)';
        } else if (pageId === 'page5') {
            statusEl.innerText = '策略建議中';
            statusEl.style.color = 'var(--secondary)';
            dotEl.style.background = 'var(--secondary)';
            dotEl.style.boxShadow = '0 0 8px var(--secondary)';
        } else if (pageId === 'page6') {
            statusEl.innerText = '執行下單中';
            statusEl.style.color = 'var(--primary)';
            dotEl.style.background = 'var(--primary)';
            dotEl.style.boxShadow = '0 0 8px var(--primary)';
        }
    }
}

// 重設應用
function resetApp() {
    document.getElementById('success').style.display = 'none';
    // 重置後返回首頁 page1
    nav('page1');
    debateFinished = false; // 允許重新進行辯論流程展示
}

// 切換「召開委員會」滑桿霓虹狀態
function toggleCommitteeMode() {
    const switchEl = document.getElementById('committee-switch');
    const labelEl = document.getElementById('committee-switch-label');
    if (switchEl) {
        switchEl.classList.toggle('active-neon');
    }
    if (labelEl && switchEl) {
        if (switchEl.classList.contains('active-neon')) {
            labelEl.classList.add('switch-label-active');
        } else {
            labelEl.classList.remove('switch-label-active');
        }
    }
}

// 處理 Page 1 (AI 聊天室) 的訊息分流與對話互動
async function sendAssistantMsg() {
    const inputEl = document.getElementById('assistant-input');
    const chatBox = document.getElementById('assistant-chat-box');
    if (!inputEl || !chatBox) return;

    const userText = inputEl.value.trim();
    if (!userText) return;

    // 1. 在畫面上新增使用者的對話泡泡
    const userMsgHtml = `
    <div class="msg-block">
        <div class="avatar" style="background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255,255,255,0.2); width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 18px;">👤</div>
        <div class="msg-content">
            <div class="msg-header"><span class="agent-name" style="color:var(--text-main)">您</span></div>
            <div class="msg-bubble">${userText}</div>
        </div>
    </div>`;
    chatBox.insertAdjacentHTML('beforeend', userMsgHtml);
    chatBox.scrollTop = chatBox.scrollHeight;
    inputEl.value = ''; // 清空輸入框

    // 2. 判斷按鈕是否啟動了召開委員會深度分析模式
    const switchEl = document.getElementById('committee-switch');
    const isCommitteeMode = switchEl && switchEl.classList.contains('active-neon');

    // 3. 打字中動畫
    const typingId = 'typing-assistant-' + Date.now();
    const typingHtml = `<div class="msg-block" id="${typingId}"><div class="avatar tech" style="background: rgba(0, 240, 255, 0.2); border: 1px solid var(--primary); width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 18px;">🤖</div><div class="msg-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div></div>`;
    chatBox.insertAdjacentHTML('beforeend', typingHtml);
    chatBox.scrollTop = chatBox.scrollHeight;

    await new Promise(r => setTimeout(r, 800)); // 模擬助理思考延遲

    // 移除打字中動畫
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (isCommitteeMode) {
        // A. 按鈕已發光，進行深度分析準備
        const systemMsgHtml = `
        <div class="msg-block">
            <div class="avatar tech" style="background: rgba(0, 240, 255, 0.2); border: 1px solid var(--primary); width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 18px;">🤖</div>
            <div class="msg-content">
                <div class="msg-header"><span class="agent-name" style="color:var(--primary)">AI 投資助理</span></div>
                <div class="msg-bubble">🚨 偵測到交易決策請求。正在啟動多代理人（Multi-Agent）架構... 準備召開 AI 投資委員會。</div>
            </div>
        </div>`;
        chatBox.insertAdjacentHTML('beforeend', systemMsgHtml);
        chatBox.scrollTop = chatBox.scrollHeight;

        const topicMatch = userText.match(/\b(BTC|ETH|DOGE|SOL)\b/i);
        currentTopic = topicMatch ? topicMatch[1].toUpperCase() : currentMarket.toUpperCase();

        // 先顯示人格分析，使用者確認後才進入委員會辯論。
        setTimeout(() => {
            pendingCommitteePrompt = userText;
            nav('page2');
            document.getElementById('committee-switch').classList.remove('active-neon');
        }, 1500);

    } else {
        // B. 按鈕未發光，智能動態對話問答 (Smart AI Financial Assistant)
        let replyText = "連線異常，無法回應。";
        try {
            const res = await apiFetch('/api/assistant-brief', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ market: currentMarket, message: userText })
            });
            const data = await res.json();
            if (res.ok && data.text) {
                replyText = data.text;
            }
        } catch (e) {
            console.error("Chat assistant error:", e);
        }

        const assistantReplyHtml = `
        <div class="msg-block">
            <div class="avatar tech" style="background: rgba(0, 240, 255, 0.2); border: 1px solid var(--primary); width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 18px;">🤖</div>
            <div class="msg-content">
                <div class="msg-header"><span class="agent-name" style="color:var(--primary)">AI 投資助理</span></div>
                <div class="msg-bubble">${replyText}</div>
            </div>
        </div>`;
        chatBox.insertAdjacentHTML('beforeend', assistantReplyHtml);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

// 切換懸浮助理面板的展開與收合
function toggleChatPanel() {
    const panel = document.querySelector('.app-container');
    const btn = document.getElementById('floating-chat-btn');
    if (panel) {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) {
            if (btn) btn.style.transform = 'rotate(15deg) scale(1.1)';
        } else {
            if (btn) btn.style.transform = 'rotate(0deg) scale(1)';
        }
    }
}

let claudeAnalysisPending = false;

function escapeClaudeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function closeClaudeAnalysis() {
    const drawer = document.getElementById('claude-analysis-drawer');
    if (drawer) drawer.classList.remove('open');
}

function renderClaudeAnalysis(payload) {
    const content = document.getElementById('claude-analysis-content');
    const meta = document.getElementById('claude-analysis-meta');
    if (!content || !payload.analysis) return;

    const analysis = payload.analysis;
    const indicators = payload.indicators || {};
    const riskLabels = { low: '低', medium: '中', high: '高' };
    const watchpoints = Array.isArray(analysis.watchpoints) ? analysis.watchpoints : [];
    const formattedTime = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString('zh-TW') : '';
    if (meta) {
        meta.textContent = `${payload.market || currentMarket.toUpperCase()} · ${payload.period || currentPeriod} 分 K · 風險：${riskLabels[String(analysis.risk_level).toLowerCase()] || analysis.risk_level || '中'} · ${formattedTime}`;
    }
    content.innerHTML = `
        <div class="claude-analysis-section">
            <h4>技術面分析</h4>
            <p>${escapeClaudeHtml(analysis.technical_analysis)}</p>
            <p style="margin-top:7px; color:var(--text-muted); font-size:10px;">RSI ${escapeClaudeHtml(indicators.rsi14)} · SMA20 ${escapeClaudeHtml(indicators.sma20)} · SMA50 ${escapeClaudeHtml(indicators.sma50)} · MACD ${escapeClaudeHtml(indicators.macd)}</p>
        </div>
        <div class="claude-analysis-section">
            <h4>最近 7 天新聞分析</h4>
            <p>${escapeClaudeHtml(analysis.news_analysis)}</p>
        </div>
        <div class="claude-analysis-section">
            <h4>整合結論</h4>
            <p>${escapeClaudeHtml(analysis.overall_summary)}</p>
            ${watchpoints.length ? `<ul class="claude-watchpoints">${watchpoints.map(item => `<li>${escapeClaudeHtml(item)}</li>`).join('')}</ul>` : ''}
        </div>
        <p style="margin:10px 0 0; color:var(--text-muted); font-size:10px;">此為 AI 研究摘要，不構成投資或交易建議。</p>
    `;
}

async function openClaudeAnalysis() {
    const drawer = document.getElementById('claude-analysis-drawer');
    const content = document.getElementById('claude-analysis-content');
    const meta = document.getElementById('claude-analysis-meta');
    if (!drawer || !content || claudeAnalysisPending) return;

    drawer.classList.add('open');
    claudeAnalysisPending = true;
    if (meta) meta.textContent = `${currentMarket.toUpperCase()} · 正在讀取 K 線、新聞並請 Claude 分析…`;
    content.innerHTML = '<div style="color:var(--primary); padding:10px 0;">✨ Claude 正在統整技術指標與最近 7 天新聞，請稍候…</div>';

    try {
        const response = await apiFetch('/api/ai-analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market: currentMarket, period: currentPeriod })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Claude 分析請求失敗');
        renderClaudeAnalysis(payload);
    } catch (error) {
        if (meta) meta.textContent = `${currentMarket.toUpperCase()} · 無法完成分析`;
        content.innerHTML = `<div style="color:var(--danger);">${escapeClaudeHtml(error.message || 'Claude 分析暫時不可用。')}</div><div style="margin-top:8px; color:var(--text-muted); font-size:10px;">請確認伺服器已設定 ANTHROPIC_API_KEY，並稍後重試。</div>`;
    } finally {
        claudeAnalysisPending = false;
    }
}

// 抓取 MAX 交易所真實 K 線走勢資料 (最近 35 根 15 分鐘線，具備 Mock 容錯機制)
async function fetchMaxKlineData() {
    try {
        const res = await apiFetch(`/api/proxy?path=/api/v2/k&market=${currentMarket}&limit=35&period=${currentPeriod}`);
        if (res.ok) {
            const kData = await res.json();
            markDataSource('K 線走勢', 'live');
            renderKlineChart(kData, true);
        } else {
            throw new Error('API 回傳狀態異常');
        }
    } catch (e) {
        console.warn(`無法獲取 MAX 交易所 K 線資料 (${currentMarket})，啟用 Mock 備用走勢:`, e.message);
        // P10：Mock 走勢上台必須讓人看得出來，價格欄位一律顯示 '--' 並亮警示橫幅
        markDataSource('K 線走勢', 'unavailable', 'Mock 模擬走勢，非即時 K 線');
        const fallbackData = generateMockKlineData(currentMarket, currentPeriod);
        renderKlineChart(fallbackData, false);
    }
}

// 手繪渲染賽博龐克風格 SVG K 線圖
function renderKlineChart(kData, isLive = true) {
    const svg = document.getElementById('kline-svg');
    if (!svg) return;

    // 取得畫布實際寬高，若無則套用預設值
    const rect = svg.getBoundingClientRect();
    const width = rect.width || 380;
    const height = rect.height || 300;

    // 只取最後 30 根 K 線作渲染
    const displayCount = 30;
    const dataSlice = kData.slice(-displayCount);

    if (dataSlice.length === 0) return;

    // A. 尋找最高與最低價
    let maxPrice = -Infinity;
    let minPrice = Infinity;
    dataSlice.forEach(k => {
        const high = Number(k[2]);
        const low = Number(k[3]);
        if (high > maxPrice) maxPrice = high;
        if (low < minPrice) minPrice = low;
    });

    // 增加上下 5% 緩衝，防止蠟燭觸頂或觸底
    const priceRange = maxPrice - minPrice;
    maxPrice += priceRange * 0.05;
    minPrice -= priceRange * 0.05;

    // B. 計算 MA5 均線 (使用原始 kData 以免第一根斷線)
    const ma5Values = [];
    for (let i = 0; i < kData.length; i++) {
        if (i < 4) {
            ma5Values.push(null);
        } else {
            let sum = 0;
            for (let j = 0; j < 5; j++) {
                sum += Number(kData[i - j][4]); // 累加收盤價 (close)
            }
            ma5Values.push(sum / 5);
        }
    }
    const ma5Slice = ma5Values.slice(-displayCount);

    // C. 開始繪製 SVG 內容
    let svgContent = '';
    const colWidth = (width - 60) / displayCount; // 預留右側 60px 繪製價格刻度
    const paddingLeft = 8;
    const chartHeight = height - 30; // 留出底部 margin

    // 1. 繪製水平價格網格虛線與右側價格刻度
    const gridCount = 4;
    for (let j = 0; j < gridCount; j++) {
        const ratio = j / (gridCount - 1);
        const price = maxPrice - ratio * (maxPrice - minPrice);
        const y = 15 + ratio * (chartHeight - 15);
        svgContent += `
            <line x1="${paddingLeft}" y1="${y}" x2="${width - 55}" y2="${y}" stroke="rgba(0, 240, 255, 0.04)" stroke-dasharray="3,3" />
            <text x="${width - 50}" y="${y + 3}" fill="var(--text-muted)" font-size="8.5" font-family="monospace" font-weight="bold">${price.toFixed(1)}</text>
        `;
    }

    // 2. 繪製 K 線燭體與影線
    dataSlice.forEach((k, i) => {
        const open = Number(k[1]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);

        const isUp = close >= open;
        const color = isUp ? 'var(--success)' : 'var(--danger)';

        const x = paddingLeft + i * colWidth + colWidth / 2;

        // 轉換價格為 Y 座標 (頂部為 0, 底部為 chartHeight)
        const yOpen = 15 + (1 - (open - minPrice) / (maxPrice - minPrice)) * (chartHeight - 15);
        const yClose = 15 + (1 - (close - minPrice) / (maxPrice - minPrice)) * (chartHeight - 15);
        const yHigh = 15 + (1 - (high - minPrice) / (maxPrice - minPrice)) * (chartHeight - 15);
        const yLow = 15 + (1 - (low - minPrice) / (maxPrice - minPrice)) * (chartHeight - 15);

        const bodyY = Math.min(yOpen, yClose);
        const bodyH = Math.max(Math.abs(yOpen - yClose), 1.5); // 最少保留 1.5px 燭身
        const rectW = colWidth * 0.72; // 燭身寬度佔 72%

        // 畫上下影線
        svgContent += `<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1.2" />`;
        // 畫燭體矩形
        svgContent += `<rect x="${x - rectW / 2}" y="${bodyY}" width="${rectW}" height="${bodyH}" fill="${color}" opacity="0.85" rx="1" />`;
    });

    // 3. 繪製 MA5 移動平均線折線
    const maPoints = [];
    ma5Slice.forEach((ma, i) => {
        if (ma !== null) {
            const x = paddingLeft + i * colWidth + colWidth / 2;
            const y = 15 + (1 - (ma - minPrice) / (maxPrice - minPrice)) * (chartHeight - 15);
            maPoints.push(`${x},${y}`);
        }
    });
    if (maPoints.length > 0) {
        svgContent += `<polyline points="${maPoints.join(' ')}" fill="none" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 3px var(--primary)); opacity:0.85;" />`;
    }


    // 十字線與互動群組
    svgContent += `
        <g id="crosshair-group" style="display:none; pointer-events:none;">
            <line id="crosshair-x" x1="0" y1="0" x2="0" y2="${chartHeight}" stroke="rgba(255,255,255,0.4)" stroke-dasharray="3,3" stroke-width="1" />
            <line id="crosshair-y" x1="${paddingLeft}" y1="0" x2="${width - 55}" y2="0" stroke="rgba(255,255,255,0.4)" stroke-dasharray="3,3" stroke-width="1" />
            <rect id="crosshair-y-bg" x="${width - 55}" y="0" width="55" height="14" fill="#111" />
            <text id="crosshair-y-label" x="${width - 50}" y="10" fill="#fff" font-size="9" font-family="monospace">0.0</text>
        </g>
    `;

    svg.innerHTML = svgContent;

    // 快取資訊供事件查表
    klineDataCache = dataSlice;
    klineLayout = { width, height, chartHeight, colWidth, paddingLeft, maxPrice, minPrice };

    setupChartInteractions(svg);


    // D. 更新頂部的即時數據資訊
    const latestK = dataSlice[dataSlice.length - 1];
    const latestClose = Number(latestK[4]);
    const latestOpen = Number(latestK[1]);
    const changePct = ((latestClose - latestOpen) / latestOpen * 100).toFixed(2);
    const sign = changePct >= 0 ? '+' : '';

    const lastPriceEl = document.getElementById('kline-last-price');
    if (lastPriceEl) {
        lastPriceEl.innerText = isLive
            ? `${latestClose.toLocaleString('en-US', {minimumFractionDigits: 1})} (${sign}${changePct}%)`
            : `${PRICE_UNAVAILABLE} (${PRICE_UNAVAILABLE})`;
        lastPriceEl.style.color = !isLive ? 'var(--danger)' : (changePct >= 0 ? 'var(--success)' : 'var(--danger)');
    }

    const highEl = document.getElementById('kline-high');
    const lowEl = document.getElementById('kline-low');
    if (highEl && lowEl) {
        highEl.innerText = isLive ? Number(latestK[2]).toLocaleString('en-US', {minimumFractionDigits: 1}) : PRICE_UNAVAILABLE;
        lowEl.innerText = isLive ? Number(latestK[3]).toLocaleString('en-US', {minimumFractionDigits: 1}) : PRICE_UNAVAILABLE;
    }
}

// 實作對接真實 MAX 交易所公開 API 資料 (具備 Mock 備用數據)
async function fetchMaxMarketData() {
    try {
        // 1. 獲取盤口深度委託 (MAX Open API)
        const depthRes = await apiFetch(`/api/proxy?path=/api/v2/depth&market=${currentMarket}&limit=10`);
        if (depthRes.ok) {
            const depthData = await depthRes.json();
            updatePhoneOrderBook(depthData);
        } else {
            throw new Error('Depth API Response Error');
        }

        // 2. 獲取即時成交價 (MAX Open API)
        const tickerRes = await apiFetch(`/api/proxy?path=/api/v2/tickers/${currentMarket}`);
        if (tickerRes.ok) {
            const tickerData = await tickerRes.json();
            markDataSource('盤口報價', 'live');
            updatePhoneMidPrice(tickerData, true);
        } else {
            throw new Error('Ticker API Response Error');
        }
    } catch (e) {
        console.warn(`無法讀取 MAX 交易所實時公開 API (${currentMarket})，啟用盤口 Mock 備用資料:`, e.message);
        // P10：Mock 盤口必須標記為非即時，中間價顯示 '--'
        markDataSource('盤口報價', 'unavailable', 'Mock 模擬盤口，非即時委託簿');

        // 抓取或生成當前代幣對應的基準價格，產生 Mock 深度與價格
        const mockKline = generateMockKlineData(currentMarket, currentPeriod);
        const lastPrice = mockKline[mockKline.length - 1][4];

        const depthMock = {
            asks: [
                [(lastPrice + lastPrice * 0.0004).toFixed(2), (Math.random() * 2 + 0.1).toFixed(2)],
                [(lastPrice + lastPrice * 0.0009).toFixed(2), (Math.random() * 3 + 0.2).toFixed(2)]
            ],
            bids: [
                [(lastPrice - lastPrice * 0.0004).toFixed(2), (Math.random() * 2 + 0.1).toFixed(2)],
                [(lastPrice - lastPrice * 0.0009).toFixed(2), (Math.random() * 3 + 0.2).toFixed(2)]
            ]
        };
        updatePhoneOrderBook(depthMock);
        updatePhoneMidPrice({ last: lastPrice.toString() }, false);
    }
}

// 動態更新盤口買賣委託 UI
function updatePhoneOrderBook(depthData) {
    const askContainer = document.getElementById('phone-asks');
    const bidContainer = document.getElementById('phone-bids');
    if (!askContainer || !bidContainer) return;

    // 定義要顯示的檔位數量 (最多 6 檔)
    const displayLimit = 6;

    // 計算最大量，用來畫背景深度條
    let maxVol = 0.001; // 防呆
    if (depthData.asks) depthData.asks.slice(0, displayLimit).forEach(a => maxVol = Math.max(maxVol, Number(a[1])));
    if (depthData.bids) depthData.bids.slice(0, displayLimit).forEach(b => maxVol = Math.max(maxVol, Number(b[1])));

    // Asks (賣單，價低在下，價高在上，所以需要 reverse)
    if (depthData.asks && depthData.asks.length > 0) {
        let asks = depthData.asks.slice(0, displayLimit);
        asks.reverse(); // 讓最低賣價在最底下 (靠近中間的 Mid Price)

        let html = '';
        asks.forEach(ask => {
            const price = Number(ask[0]);
            const vol = Number(ask[1]);
            const pct = Math.min(100, (vol / maxVol) * 100);
            html += `
            <div style="display:flex; justify-content:space-between; color:var(--danger); position:relative; padding: 2px 0;">
                <div style="position:absolute; right:0; top:0; bottom:0; width:${pct}%; background:rgba(255, 0, 60, 0.05); z-index:1;"></div>
                <span style="z-index:2;">${price.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 2})}</span>
                <span style="z-index:2;">${vol.toFixed(3)}</span>
            </div>
            `;
        });
        askContainer.innerHTML = html;
    }

    // Bids (買單，價高在上，價低在下，API 預設就是 descending，不需 reverse)
    if (depthData.bids && depthData.bids.length > 0) {
        let bids = depthData.bids.slice(0, displayLimit);

        let html = '';
        bids.forEach(bid => {
            const price = Number(bid[0]);
            const vol = Number(bid[1]);
            const pct = Math.min(100, (vol / maxVol) * 100);
            html += `
            <div style="display:flex; justify-content:space-between; color:var(--success); position:relative; padding: 2px 0;">
                <div style="position:absolute; right:0; top:0; bottom:0; width:${pct}%; background:rgba(57, 255, 20, 0.05); z-index:1;"></div>
                <span style="z-index:2;">${price.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 2})}</span>
                <span style="z-index:2;">${vol.toFixed(3)}</span>
            </div>
            `;
        });
        bidContainer.innerHTML = html;
    }
}

// 動態更新 UI
function updatePhoneMidPrice(tickerData, isLive = true) {
    const midPriceEl = document.getElementById('phone-mid-price');
    if (!midPriceEl) return;
    if (!isLive || !tickerData || !tickerData.last) {
        // P10：非即時來源不顯示任何數字
        midPriceEl.innerText = PRICE_UNAVAILABLE;
        midPriceEl.style.color = 'var(--danger)';
        return;
    }
    const price = Number(tickerData.last);
    midPriceEl.innerText = price.toLocaleString('en-US', {minimumFractionDigits: 2});
    midPriceEl.style.color = '#fff';
}

// 實作商品搜尋與切換機制 (自動跳轉至 K 線詳情視圖)
function changeMarket(newMarket) {
    if (!newMarket) return;
    currentMarket = newMarket.toLowerCase().trim();

    // 更新詳細看盤頁的商品名稱
    const displayMarket = currentMarket.toUpperCase();
    const titleEl = document.getElementById('kline-market-title');
    const obTitleEl = document.getElementById('order-book-market-title');
    if (titleEl) titleEl.innerText = displayMarket;
    if (obTitleEl) obTitleEl.innerText = displayMarket;

    // 立即清空舊的畫布與報價
    const svg = document.getElementById('kline-svg');
    if (svg) svg.innerHTML = '<text x="50%" y="50%" fill="var(--text-muted)" font-size="12" text-anchor="middle">Loading...</text>';

    const lastPriceEl = document.getElementById('kline-last-price');
    if (lastPriceEl) {
        lastPriceEl.innerText = '--';
        lastPriceEl.style.color = '#fff';
    }

    const highEl = document.getElementById('kline-high');
    const lowEl = document.getElementById('kline-low');
    if (highEl) highEl.innerText = '--';
    if (lowEl) lowEl.innerText = '--';

    const midPriceEl = document.getElementById('phone-mid-price');
    if (midPriceEl) midPriceEl.innerText = '--';

    const askContainer = document.getElementById('phone-asks');
    const bidContainer = document.getElementById('phone-bids');
    if (askContainer) askContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px; padding: 10px;">讀取中...</div>';
    if (bidContainer) bidContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px; padding: 10px;">讀取中...</div>';

    const newsContainer = document.getElementById('phone-news-list');
    if (newsContainer) newsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px; padding: 10px;">正在加載即時新聞...</div>';

    // 滑入/切換為詳細 K 線圖視圖
    showKlineChartView();
}

// 顯示行情自選首頁
let homePollingInterval = null;
let chartPollingInterval = null;

function showDashboardHomeView() {
    activeDashboardView = 'home';
    const homeView = document.getElementById('dashboard-home-view');
    const chartView = document.getElementById('dashboard-chart-view');
    const learningView = document.getElementById('learning-view');
    const disciplineView = document.getElementById('discipline-view');
    const viperView = document.getElementById('viper-view');
    if (homeView) homeView.style.display = 'flex';
    if (chartView) chartView.style.display = 'none';
    if (learningView) learningView.classList.remove('open');
    if (disciplineView) disciplineView.classList.remove('open');
    if (viperView) viperView.classList.remove('open');

    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);

    fetchMaxAllTickers();
    updateHomeNews();

    homePollingInterval = setInterval(() => {
        if (activeDashboardView === 'home') {
            fetchMaxAllTickers();
        }
    }, 15000); // 延長至 15 秒避免 MAX API Rate Limit 封鎖
}

function showKlineChartView() {
    activeDashboardView = 'chart';
    const homeView = document.getElementById('dashboard-home-view');
    const chartView = document.getElementById('dashboard-chart-view');
    const learningView = document.getElementById('learning-view');
    if (homeView) homeView.style.display = 'none';
    if (chartView) chartView.style.display = 'flex';
    if (learningView) learningView.classList.remove('open');

    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);

    fetchMaxKlineData();
    fetchMaxMarketData();
    updatePhoneNews(currentMarket);

    chartPollingInterval = setInterval(() => {
        if (activeDashboardView === 'chart') {
            fetchMaxKlineData();
            fetchMaxMarketData();
        }
    }, 15000); // 延長至 15 秒避免 MAX API Rate Limit 封鎖
}

// 學習闖關：進度僅保存於目前瀏覽器，不會送到伺服器。
function loadLearningProgress() {
    try {
        const saved = JSON.parse(localStorage.getItem(LEARNING_PROGRESS_KEY) || '[]');
        learningProgress = new Set(saved.filter(stage => Number.isInteger(stage) && stage >= 1 && stage <= 3));
    } catch (error) {
        learningProgress = new Set();
    }
}

function saveLearningProgress() {
    localStorage.setItem(LEARNING_PROGRESS_KEY, JSON.stringify([...learningProgress]));
}

function showLearningView() {
    activeDashboardView = 'learning';
    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);
    const homeView = document.getElementById('dashboard-home-view');
    const chartView = document.getElementById('dashboard-chart-view');
    const learningView = document.getElementById('learning-view');
    if (homeView) homeView.style.display = 'none';
    if (chartView) chartView.style.display = 'none';
    if (learningView) learningView.classList.add('open');
    renderLearningProgress();
}

let disciplineSimulationActive = false;
function showDisciplineView() {
    activeDashboardView = 'discipline';
    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);
    document.getElementById('dashboard-home-view')?.style && (document.getElementById('dashboard-home-view').style.display = 'none');
    document.getElementById('dashboard-chart-view')?.style && (document.getElementById('dashboard-chart-view').style.display = 'none');
    document.getElementById('learning-view')?.classList.remove('open');
    document.getElementById('discipline-view')?.classList.add('open');
}
let viperProfile = null;
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
function viperText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function viperScorePoint(score, index, total = 4) {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / total);
    const radius = 78 * Math.max(0, Math.min(100, Number(score) || 0)) / 100;
    return `${130 + Math.cos(angle) * radius},${112 + Math.sin(angle) * radius}`;
}
function renderViperProfile(profile, diagnosis, mode) {
    const scores = profile.scores || {};
    const points = ['fomo', 'switching', 'intensity', 'concentration'].map((key, index) => viperScorePoint(scores[key], index)).join(' ');
    const polygon = document.getElementById('viper-radar-polygon');
    if (polygon) polygon.setAttribute('points', points);
    viperText('viper-mode-label', mode === 'ai' ? 'AI + 匯入資料' : '匯入資料');
    viperText('viper-title', diagnosis.headline || '交易行為摘要');
    viperText('viper-script', diagnosis.analysis || '無法產生摘要。');
    viperText('viper-fomo', `${scores.fomo ?? '-'} 追價傾向`);
    viperText('viper-switching', `${scores.switching ?? '-'} 反手頻率`);
    viperText('viper-intensity', `${scores.intensity ?? '-'} 交易密度`);
    viperText('viper-concentration', `${scores.concentration ?? '-'} 幣種集中`);
    const observations = document.getElementById('viper-observations');
    if (observations) observations.innerHTML = (diagnosis.observations || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const disclaimer = document.getElementById('viper-disclaimer');
    if (disclaimer) disclaimer.textContent = diagnosis.disclaimer || '本分析僅供教育與研究參考，不構成投資建議。';
}
async function loadViperDiagnosis() {
    viperText('viper-script', '正在讀取去識別化 CSV 彙總資料並產生行為摘要…');
    try {
        const profileResponse = await fetch('user_behavior_profile.json', { cache: 'no-store' });
        if (!profileResponse.ok) throw new Error('尚未匯入 CSV 行為摘要。');
        viperProfile = await profileResponse.json();
        const response = await apiFetch('/api/viper-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: viperProfile }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '行為摘要服務暫時不可用。');
        renderViperProfile(result.profile || viperProfile, result.diagnosis || {}, result.mode);
    } catch (error) {
        viperText('viper-mode-label', '尚未匯入');
        viperText('viper-title', '需要匯入 CSV 彙總資料');
        viperText('viper-script', `無法產生真實資料診斷：${error.message}。原始 CSV 不會上傳到網站；請先在本機使用匯入工具產生去識別化摘要。`);
    }
}
function showViperView() {
    activeDashboardView = 'viper';
    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);
    document.getElementById('dashboard-home-view')?.style && (document.getElementById('dashboard-home-view').style.display = 'none');
    document.getElementById('dashboard-chart-view')?.style && (document.getElementById('dashboard-chart-view').style.display = 'none');
    document.getElementById('learning-view')?.classList.remove('open');
    document.getElementById('discipline-view')?.classList.remove('open');
    document.getElementById('viper-view')?.classList.add('open');
    loadViperDiagnosis();
}
function nextViperScript() { loadViperDiagnosis(); }
function startDisciplineSimulation() {
    disciplineSimulationActive = true;
    const asset = document.getElementById('discipline-asset')?.value || 'USDT';
    document.getElementById('discipline-result').textContent = `已簽署模擬合約：以 ${asset} 作為示意保證金；系統不會扣款、不會連結錢包。請選擇守約或違規情境。`;
}
function resolveDisciplineSimulation(keptPlan) {
    const result = document.getElementById('discipline-result');
    if (!disciplineSimulationActive) { result.textContent = '請先簽署模擬合約。'; return; }
    if (keptPlan) result.textContent = '✓ 模擬守約：示意返還保證金並獲得 2% 獎勵券；此結果不會產生任何真實資產或收益。';
    else { document.getElementById('discipline-pool').textContent = '1,260 USDT（模擬）'; result.textContent = '⚠ 模擬違規：示意 10% 保證金進入獎金池；此結果不會沒收任何真實資產。'; }
}

function renderLearningProgress() {
    const completed = learningProgress.size;
    const progressBar = document.getElementById('learn-progress-bar');
    const progressText = document.getElementById('learn-progress-text');
    if (progressBar) progressBar.style.width = `${(completed / 3) * 100}%`;
    if (progressText) progressText.textContent = completed === 3 ? '🎉 已完成 3 / 3 關，完成新手訓練！' : `已完成 ${completed} / 3 關`;

    document.querySelectorAll('.stage-card[data-stage]').forEach(card => {
        const stage = Number(card.dataset.stage);
        const unlocked = stage === 1 || learningProgress.has(stage - 1);
        const done = learningProgress.has(stage);
        card.classList.toggle('locked', !unlocked);
        card.classList.toggle('done', done);
        const status = card.querySelector('.stage-status');
        if (status) status.textContent = done ? '✓ 已完成' : (unlocked ? '進行中' : '尚未解鎖');
        card.querySelectorAll('.quiz-option').forEach(button => {
            button.disabled = !unlocked || done;
            button.classList.remove('correct', 'wrong');
            if (done && button.dataset.answer === learningAnswers[stage]) button.classList.add('correct');
        });
        const feedback = document.getElementById(`quiz-feedback-${stage}`);
        if (feedback && done) {
            feedback.textContent = '答對了！下一關已解鎖。';
            feedback.className = 'quiz-feedback success';
        } else if (feedback) {
            feedback.textContent = '';
            feedback.className = 'quiz-feedback';
        }
    });
}

function answerLearningQuiz(stage, answer) {
    const feedback = document.getElementById(`quiz-feedback-${stage}`);
    if (learningProgress.has(stage) || (stage > 1 && !learningProgress.has(stage - 1))) return;
    if (answer === learningAnswers[stage]) {
        learningProgress.add(stage);
        saveLearningProgress();
        renderLearningProgress();
    } else if (feedback) {
        feedback.textContent = '再想一下：回到本關的知識點，找找關鍵字。';
        feedback.className = 'quiz-feedback';
        const selected = document.querySelector(`.quiz-option[data-stage="${stage}"][data-answer="${answer}"]`);
        if (selected) {
            selected.classList.add('wrong');
            setTimeout(() => selected.classList.remove('wrong'), 700);
        }
    }
}

function resetLearningProgress() {
    learningProgress.clear();
    localStorage.removeItem(LEARNING_PROGRESS_KEY);
    renderLearningProgress();
}

function startMarketPractice() {
    changeMarket('btcusdt');
    showKlineChartView();
}

// 抓取多檔自選代幣即時報價 (對接 MAX 官方 Tickers API，具備 Mock 容錯)
async function fetchMaxAllTickers() {
    const listContainer = document.getElementById('market-list-container');
    if (!listContainer) return;

    const markets = ['btcusdt', 'ethusdt', 'dogeusdt', 'solusdt'];
    try {
        const res = await apiFetch('/api/proxy?path=/api/v2/tickers');
        if (res.ok) {
            const allTickers = await res.json();
            markDataSource('行情列表', 'live');
            renderMarketList(allTickers, markets);
            return;
        }
        throw new Error(`Tickers API 回傳狀態 ${res.status}`);
    } catch (e) {
        console.warn('無法取得 MAX 即時行情列表，改向後端 /api/market 查詢:', e.message);
    }

    // P10：不再以任何硬編碼價格池填補。僅接受後端明示 dataSource === 'live' 的報價，
    // 其餘一律顯示 '--' 並亮出警示橫幅。
    const backendTickers = {};
    try {
        const backendRes = await apiFetch('/api/market?market=soltwd');
        if (backendRes.ok) {
            const bData = await backendRes.json();
            if (bData.dataSource === 'live' && bData.price !== null && bData.price !== undefined) {
                const open = bData.change24h ? Number(bData.price) / (1 + Number(bData.change24h) / 100) : Number(bData.price);
                backendTickers.soltwd = { last: String(bData.price), open: String(open) };
                if (!markets.includes('soltwd')) markets.push('soltwd');
            }
        }
    } catch (err) {
        console.warn('後端 /api/market 查詢失敗:', err.message);
    }

    markDataSource('行情列表', 'unavailable', '完整行情列表來源不可用，缺價項目顯示為 --');
    renderMarketList(backendTickers, markets);
}

// 渲染自選商品行情列表
function renderMarketList(allTickers, markets) {
    const listContainer = document.getElementById('market-list-container');
    if (!listContainer) return;

    let html = '';
    markets.forEach(m => {
        const data = allTickers ? allTickers[m] : null;
        const last = data ? Number(data.last) : NaN;
        const open = data ? Number(data.open) : NaN;
        const hasQuote = Number.isFinite(last) && Number.isFinite(open) && open !== 0;

        // 格式化顯示名稱如 BTC/USDT
        const displayName = m.toUpperCase().replace('USDT', '/USDT').replace('TWD', '/TWD');

        // P10：無可信報價時顯示 '--'，不得以任何替代數值填補
        let priceCell = `<span style="font-family:monospace; font-weight:bold; font-size:14px; color:var(--danger);">${PRICE_UNAVAILABLE}</span>`;
        let badgeCell = `<span class="market-badge" style="color:var(--danger); border:1px solid var(--danger); background:rgba(255,0,60,0.08);">${PRICE_UNAVAILABLE}</span>`;

        if (hasQuote) {
            const changePct = ((last - open) / open * 100).toFixed(2);
            const isUp = changePct >= 0;
            const sign = isUp ? '+' : '';
            const badgeClass = isUp ? 'badge-up' : 'badge-down';
            const formattedPrice = last.toLocaleString('en-US', { minimumFractionDigits: m.includes('doge') ? 4 : 1 });
            priceCell = `<span style="font-family:monospace; font-weight:bold; font-size:14px; color:#fff;">${formattedPrice}</span>`;
            badgeCell = `<span class="market-badge ${badgeClass}">${sign}${changePct}%</span>`;
        }

        html += `
            <div class="market-row" onclick="changeMarket('${m}')">
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <span style="font-weight:bold; font-size:13.5px; color:#fff;">${displayName}</span>
                    <span style="font-size:10px; color:var(--text-muted);">${hasQuote ? 'MAX 交易所' : '⚠ 報價不可用'}</span>
                </div>
                <div style="display:flex; align-items:center; gap:16px;">
                    ${priceCell}
                    ${badgeCell}
                </div>
            </div>
        `;
    });
    listContainer.innerHTML = html;
}

// 渲染自選行情首頁綜合快訊新聞
async function updateHomeNews() {
    const homeNewsContainer = document.getElementById('home-news-container');
    if (!homeNewsContainer) return;

    homeNewsContainer.innerHTML = `
        <div style="color:var(--text-muted); text-align:center; padding:10px;">
            <span class="typing-indicator" style="display:inline-block; margin-bottom:5px;"><span></span><span></span><span></span></span><br>
            載入即時快訊中...
        </div>
    `;

    try {
        const response = await apiFetch('/api/news?_t=' + new Date().getTime());
        if (response.ok) {
            const data = await response.json();
            if (data.news && data.news.length > 0) {
                let html = '';
                const colors = ['var(--primary)', 'var(--secondary)', 'var(--warning)', 'var(--success)', 'var(--danger)'];

                data.news.slice(0, 3).forEach((item, index) => {
                    let dateStr = item.pubDate;
                    try {
                        const d = new Date(item.pubDate);
                        if (!isNaN(d)) dateStr = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    } catch(e) {}

                    const borderColor = colors[index % colors.length];
                    const marginTop = index === 0 ? '0' : '6px';
                    const borderTop = index === 0 ? 'none' : '1px solid rgba(255,255,255,0.03)';
                    const paddingTop = index === 0 ? '0' : '6px';

                    html += `
                        <div style="border-top: ${borderTop}; padding-top: ${paddingTop}; border-left: 2px solid ${borderColor}; padding-left: 6px; margin-top: ${marginTop};">
                            <span style="color:var(--text-muted); font-size: 9px;">${dateStr}</span>
                            <a href="${item.link}" target="_blank" style="color:#fff; font-weight:bold; text-decoration: none; display: block; margin-top: 2px;">
                                ${item.title}
                            </a>
                        </div>
                    `;
                });
                homeNewsContainer.innerHTML = html;
            } else {
                homeNewsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px;">目前沒有綜合快訊。</div>';
            }
        }
    } catch (e) {
        console.warn('載入綜合快訊失敗:', e);
        homeNewsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px;">載入新聞失敗，請稍後再試。</div>';
    }
}

// K 線 Mock 資料生成器 (在斷網或 CORS 阻擋時提供精美走勢)
function generateMockKlineData(market, period = 5) {
    const p = Number(period) * 60; // seconds
    let basePrice = 99200;
    if (market.includes('eth')) basePrice = 3300;
    else if (market.includes('doge')) basePrice = 0.12;
    else if (market.includes('sol')) basePrice = 180;
    else if (market.includes('xrp')) basePrice = 0.58;

    const mockData = [];
    let currentPrice = basePrice;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 35; i >= 0; i--) {
        const timestamp = now - i * 900;
        // 隨機生成波動，符合賽博朋克起伏
        const change = (Math.random() - 0.49) * (basePrice * 0.015);
        const open = currentPrice;
        const close = currentPrice + change;
        const high = Math.max(open, close) + Math.random() * (basePrice * 0.005);
        const low = Math.min(open, close) - Math.random() * (basePrice * 0.005);
        const volume = Math.random() * 50;
        mockData.push([timestamp, open, high, low, close, volume]);
        currentPrice = close;
    }
    return mockData;
}

// 根據商品種類，動態更新相關快訊 (使用真實資料 API)
async function updatePhoneNews(market) {
    const newsContainer = document.getElementById('phone-news-list');
    if (!newsContainer) return;

    newsContainer.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:10px;"><span class="typing-indicator" style="display:inline-block; margin-bottom:5px;"><span></span><span></span><span></span></span><br>載入即時快訊中...</div>';

    try {
        const symbol = market.toUpperCase().replace('USDT', '').replace('TWD', '');
        const response = await apiFetch(`/api/news?market=${symbol}`);
        if (response.ok) {
            const data = await response.json();
            if (data.news && data.news.length > 0) {
                let html = '';
                data.news.forEach(item => {
                    let dateStr = item.pubDate;
                    try {
                        const d = new Date(item.pubDate);
                        if (!isNaN(d)) dateStr = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    } catch(e) {}

                    html += `
                        <div style="padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 6px;">
                            <a href="${item.link}" target="_blank" style="color: var(--primary); text-decoration: none; font-weight: bold; display: block; margin-bottom: 2px;">
                                ${item.title}
                            </a>
                            <span style="color: var(--text-muted); font-size: 9px;">${dateStr}</span>
                        </div>
                    `;
                });
                newsContainer.innerHTML = html;
            } else {
                newsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px;">目前沒有此幣種相關的新聞。</div>';
            }
        }
    } catch (e) {
        console.warn('載入專屬新聞快訊失敗:', e);
        newsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:10px;">載入新聞失敗，請稍後再試。</div>';
    }
}

function changePeriod(period, btnElement) {
    currentPeriod = period;
    const btns = document.querySelectorAll('.period-btn');
    btns.forEach(b => b.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    // Immediate feedback UX
    const svgContainer = document.getElementById('kline-svg');
    if (svgContainer) {
        svgContainer.innerHTML = '<text x="50%" y="50%" fill="var(--text-muted)" font-size="12" text-anchor="middle">Loading...</text>';
    }

    fetchMaxKlineData();
}

function setupChartInteractions(svg) {
    const crosshair = document.getElementById('crosshair-group');
    const cx = document.getElementById('crosshair-x');
    const cy = document.getElementById('crosshair-y');
    const cyBg = document.getElementById('crosshair-y-bg');
    const cyLabel = document.getElementById('crosshair-y-label');
    const tooltip = document.getElementById('kline-tooltip');

    function updateCrosshair(clientX, clientY) {
        if (!crosshair || !cx || !cy || !tooltip) return;

        const rect = svg.getBoundingClientRect();
        let x = clientX - rect.left;
        let y = clientY - rect.top;

        // 邊界防護
        if (x < klineLayout.paddingLeft || x > klineLayout.width - 55) {
            crosshair.style.display = 'none';
            tooltip.innerHTML = `<span>高:<span style="color:#fff">--</span></span><span>低:<span style="color:#fff">--</span></span>`;
            return;
        }

        // 計算選中的 K 棒
        let index = Math.floor((x - klineLayout.paddingLeft) / klineLayout.colWidth);
        if (index < 0) index = 0;
        if (index >= klineDataCache.length) index = klineDataCache.length - 1;

        const kData = klineDataCache[index];
        if (!kData) return;

        const open = Number(kData[1]);
        const high = Number(kData[2]);
        const low = Number(kData[3]);
        const close = Number(kData[4]);
        const vol = Number(kData[5]);
        const ts = new Date(kData[0] * 1000);
        const timeStr = `${ts.getMonth()+1}/${ts.getDate()} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;

        // 顏色邏輯 (漲綠跌紅)
        const color = close >= open ? 'var(--success)' : 'var(--danger)';

        // 更新 UI 面板
        tooltip.innerHTML = `
            <span>${timeStr}</span>
            <span>開:<span style="color:${color}">${open}</span></span>
            <span>高:<span style="color:${color}">${high}</span></span>
            <span>低:<span style="color:${color}">${low}</span></span>
            <span>收:<span style="color:${color}">${close}</span></span>
            <span>量:<span style="color:#fff">${vol.toFixed(2)}</span></span>
        `;

        // 十字線 X 軸對齊 K 棒中心
        const candleX = klineLayout.paddingLeft + index * klineLayout.colWidth + (klineLayout.colWidth * 0.4);

        // 自動鎖定到收盤價 (Snap to Close)
        const priceRange = klineLayout.maxPrice - klineLayout.minPrice;
        const yPrice = close; // 強制為收盤價
        let ratio = 0;
        if (priceRange > 0) {
            ratio = (klineLayout.maxPrice - yPrice) / priceRange;
        }
        y = 15 + ratio * (klineLayout.chartHeight - 15);

        // 移動十字線與 Y 軸標籤
        crosshair.style.display = 'inline';
        cx.setAttribute('x1', candleX);
        cx.setAttribute('x2', candleX);
        cy.setAttribute('y1', y);
        cy.setAttribute('y2', y);

        cyBg.setAttribute('y', y - 7);
        cyLabel.setAttribute('y', y + 3);
        cyLabel.textContent = yPrice.toFixed(2);
    }

    // 綁定事件
    svg.addEventListener('mousemove', (e) => {
        updateCrosshair(e.clientX, e.clientY);
    });

    svg.addEventListener('mouseleave', () => {
        if(crosshair) crosshair.style.display = 'none';
        if(tooltip) tooltip.innerHTML = `<span>高:<span style="color:#fff">--</span></span><span>低:<span style="color:#fff">--</span></span>`;
    });

    // 手機觸控事件
    svg.addEventListener('touchstart', (e) => {
        e.preventDefault(); // 防止滾動
        const touch = e.touches[0];
        updateCrosshair(touch.clientX, touch.clientY);
    }, {passive: false});

    svg.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        updateCrosshair(touch.clientX, touch.clientY);
    }, {passive: false});

    svg.addEventListener('touchend', () => {
        if(crosshair) crosshair.style.display = 'none';
        if(tooltip) tooltip.innerHTML = `<span>高:<span style="color:#fff">--</span></span><span>低:<span style="color:#fff">--</span></span>`;
    });
}

function switchTab(tab) {
    const astBox = document.getElementById('assistant-chat-box');
    const debBox = document.getElementById('debate-chat-box');
    const astBtn = document.getElementById('tab-btn-assistant');
    const debBtn = document.getElementById('tab-btn-debate');
    const inputArea = document.querySelector('.chat-input-area');

    if (tab === 'assistant') {
        astBox.style.display = 'flex';
        debBox.style.display = 'none';
        inputArea.style.display = 'flex';
        astBtn.style.background = 'rgba(112,0,255,0.2)';
        astBtn.style.border = '1px solid var(--primary)';
        astBtn.style.color = '#fff';
        debBtn.style.background = 'transparent';
        debBtn.style.border = '1px solid rgba(255,255,255,0.2)';
        debBtn.style.color = 'var(--text-muted)';
    } else {
        astBox.style.display = 'none';
        debBox.style.display = 'flex';
        inputArea.style.display = 'none'; // 隱藏原本的對話框，改用辯論區的
        debBtn.style.background = 'rgba(112,0,255,0.2)';
        debBtn.style.border = '1px solid var(--primary)';
        debBtn.style.color = '#fff';
        astBtn.style.background = 'transparent';
        astBtn.style.border = '1px solid rgba(255,255,255,0.2)';
        astBtn.style.color = 'var(--text-muted)';
    }
}

function sendLiveMessage() {
    const input = document.getElementById('live-chat-input');
    const text = input.value.trim();
    if (!text) return;
    
    appendLiveMessage(text, 'user', '我');
    input.value = '';
    

    appendLiveMessage(text, 'user', '我');
    input.value = '';

    simulateLiveChatResponse(text);
}

function appendLiveMessage(text, senderType, senderName) {
    const container = document.getElementById('live-chat-messages');
    const msgBlock = document.createElement('div');
    msgBlock.className = `live-msg ${senderType}`;
    msgBlock.style.opacity = '0';
    msgBlock.style.animation = 'fadeInMsg 0.4s ease forwards';
    
    if (senderType === 'ai') senderName = '🤖 ' + senderName;
    
    msgBlock.innerHTML = `
        <span class="name">${senderName}</span>
        <span class="text">${text}</span>
    `;
    

    if (senderType === 'ai') senderName = '🤖 ' + senderName;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = senderName;
    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = text;
    msgBlock.append(nameEl, textEl);

    container.appendChild(msgBlock);
    container.scrollTop = container.scrollHeight;
}

let liveChatSimInterval = null;

function startLiveChatSimulation() {
    if (liveChatSimInterval) clearInterval(liveChatSimInterval);
    liveChatSimInterval = setInterval(() => {
        const otherUsers = ['CryptoKing', 'MoonBoy99', '韭菜一號', 'TraderX', '大戶哥', '合約戰神', '梭哈就對了', '分析師小陳', '賺爛了', '套牢中'];
        const responses = [
            '這波行情真的看不懂...',
            '有人要一起做多嗎？',
            '我已經平倉觀望了',
            '太刺激了吧！',
            '今晚 CPI 數據要公佈了，大家小心',
            '空軍集合！',
            '多軍大獲全勝🚀',
            '剛爆倉了，還有機會嗎？',
            '我感覺要跌了，快逃',
            '這支幣還有救嗎？',
            '突破壓力位了！',
            '市場有點過熱了吧？',
            '幹，又被掃損了',
            '真的一直洗盤誒'
        ];
        
        const randomUser = otherUsers[Math.floor(Math.random() * otherUsers.length)];
        const randomRes = responses[Math.floor(Math.random() * responses.length)];
        appendLiveMessage(randomRes, 'other', randomUser);
        
        // 偶爾讓 AI 對模擬用戶的危險發言主動回覆
        if (Math.random() > 0.8) {
            triggerAIResponseIfKeyword(randomRes);
        } else if (Math.random() > 0.85) {
            // 陣營 AI 總司令喊話
            if (currentBullPct > 60) {
                appendLiveMessage('兄弟們！空軍快不行了，繼續加倉把他們爆掉！🚀', 'ai', '🐂 多軍總司令');
            } else if (currentBullPct < 40) {
                appendLiveMessage('市場情緒太脆弱了，跟我一起做空，讓多軍見血！🩸', 'ai', '🐻 空軍總司令');
            } else if (Math.random() > 0.5) {
                appendLiveMessage('目前勢均力敵，多軍弟兄們別放棄，守住支撐！🛡️', 'ai', '🐂 多軍總司令');
            } else {
                appendLiveMessage('多軍還在死撐，空軍集合，準備倒貨！📉', 'ai', '🐻 空軍總司令');
            }

        }
    }, Math.floor(Math.random() * 5000) + 3000); // 3 ~ 8 秒隨機發一句
}

function stopLiveChatSimulation() {
    if (liveChatSimInterval) clearInterval(liveChatSimInterval);
}

// 模擬呼叫真實 Claude API 的 Promise，方便未來串接真實後端
async function callRealClaudeAPI(userText) {
    return new Promise((resolve) => {
        setTimeout(() => {
            let aiMsg = `分析當前市場狀態... 目前呈現震盪整理，建議嚴守紀律，多看少做。`;
            

            if (userText.includes('市場過熱') || userText.includes('過熱')) {
                aiMsg = `⚠️ 偵測到「過熱」訊號：目前市場情緒確實出現 FOMO 極值，建議您檢查持倉水位，避免追高風險。`;
            } else if (userText.includes('幹') || userText.includes('靠北') || userText.includes('媽的') || userText.includes('爆倉')) {
                aiMsg = `🚨 投資人格偵測：您的語氣顯示可能受到情緒影響 (Tilt)。強烈建議您暫停交易，離開盤面休息一下，避免連續虧損。`;
            } else if (userText.includes('快逃') || userText.includes('要跌')) {
                aiMsg = `技術面顯示下方支撐在 58,000 附近，若跌破可能引發連鎖反應，請設定好停損。`;
            } else if (userText.includes('做多') || userText.includes('🚀')) {
                aiMsg = `突破關鍵壓力位確實有動能，但仍需提防假突破，請以小倉位試單。`;
            } else if (userText.toLowerCase().includes('@ai')) {
                let cleanText = userText.replace(/@ai/ig, '').trim();
                if (cleanText) {
                    aiMsg = `針對您提到的「${cleanText}」，目前技術指標動能不足，請留意後續風險。建議點擊商品進入我的專屬面板查看詳細解析！`;
                }
            }
            resolve(aiMsg);
        }, 1500);
    });
}

function triggerAIResponseIfKeyword(text) {
    const hasAIKeyword = text.toLowerCase().includes('@ai') ||
                         text.includes('分析') || text.includes('走勢') ||
                         text.includes('市場過熱') || text.includes('過熱') ||
                         text.includes('幹') || text.includes('靠北') || text.includes('媽的') || text.includes('爆倉') ||
                         text.includes('快逃') || text.includes('要跌');
    

    if (hasAIKeyword) {
        // 使用 async 呼叫模擬的 Claude API
        callRealClaudeAPI(text).then((aiResponse) => {
            appendLiveMessage(aiResponse, 'ai', 'AI 助理');
        });
    }
}

function simulateLiveChatResponse(userText) {
    // 檢查使用者的輸入是否觸發 AI 關鍵字
    triggerAIResponseIfKeyword(userText);
}

// --- AI 多空陣營戰 (Faction War) 邏輯 ---

let currentBullPct = 50;
let userFaction = null;
let factionWarInterval = null;

function initFactionWar() {
    if (factionWarInterval) clearInterval(factionWarInterval);
    updateFactionUI();
    factionWarInterval = setInterval(() => {
        // 隨機變動 1~3%
        const change = (Math.random() * 6 - 3);
        currentBullPct = Math.max(10, Math.min(90, currentBullPct + change));
        updateFactionUI();
    }, 2000);
}

function updateFactionUI() {
    const bullBar = document.getElementById('faction-bull-bar');
    const bearBar = document.getElementById('faction-bear-bar');
    const centerLine = document.getElementById('faction-center-line');
    const bullPctText = document.getElementById('faction-bull-pct');
    const bearPctText = document.getElementById('faction-bear-pct');
    
    if (bullBar && bearBar && centerLine) {
        bullBar.style.width = `${currentBullPct}%`;
        bearBar.style.width = `${100 - currentBullPct}%`;
        centerLine.style.left = `${currentBullPct}%`;
        
        bullPctText.innerText = `${currentBullPct.toFixed(1)}%`;
        bearPctText.innerText = `${(100 - currentBullPct).toFixed(1)}%`;
    }
}

function joinFaction(faction) {
    if (userFaction) return; // 已經加入過
    userFaction = faction;
    
    const btnBull = document.getElementById('btn-join-bull');
    const btnBear = document.getElementById('btn-join-bear');
    
    btnBull.disabled = true;
    btnBear.disabled = true;
    
    if (faction === 'bull') {
        btnBull.innerHTML = '🐂 已加入多軍';
        btnBull.style.background = 'rgba(57,255,20,0.3)';
        btnBull.style.boxShadow = '0 0 15px var(--success)';
        btnBear.style.opacity = '0.3';
        currentBullPct += 15; // 給予多軍 15% 激勵，視覺效果明顯
    } else {
        btnBear.innerHTML = '🐻 已加入空軍';
        btnBear.style.background = 'rgba(255,0,85,0.3)';
        btnBear.style.boxShadow = '0 0 15px var(--danger)';
        btnBull.style.opacity = '0.3';
        currentBullPct -= 15; // 給予空軍 15% 激勵
    }
    
    updateFactionUI();
    
    // 陣營加入動畫回饋 (聊天室推播)
    setTimeout(() => {
        const factionName = faction === 'bull' ? '多軍' : '空軍';
        appendLiveMessage(`系統廣播：一位勇敢的交易者加入了 ${factionName}！為信仰充值！`, 'ai', '⚔️ 系統');
    }, 500);
}

// 啟動陣營戰隨機波動
initFactionWar();

// --- 👿 毒舌 AI 投資教練 (Toxic AI Coach) 邏輯 ---

let toxicTypeTimeout = null;

function openToxicCoach() {
    const modal = document.getElementById('toxic-ai-modal');
    modal.style.display = 'flex';
    
    // 生成隨機 DNA 數據
    const traits = [
        { label: 'FOMO 指數', val: Math.floor(Math.random() * 40) + 60 },
        { label: '凹單毅力', val: Math.floor(Math.random() * 50) + 50 },
        { label: '停損果斷', val: Math.floor(Math.random() * 30) },
        { label: '韭菜純度', val: Math.floor(Math.random() * 30) + 70 },
        { label: '合約信仰', val: Math.floor(Math.random() * 60) + 40 },
        { label: '做多執念', val: Math.floor(Math.random() * 50) + 50 }
    ];
    
    drawRadarChart(traits);
    
    // 毒舌語錄庫
    const roasts = [
        "掃描完你的交易紀錄了。老實說，我奶奶擲筊的勝率都比你高。上週在山頂全倉做多，跌了又死不肯停損。你這不是在投資，這是在做公益。",
        "你的投資 DNA 顯示出極致的『高買低賣』天賦。別人恐懼你貪婪，別人貪婪你破產。建議直接把錢捐給流浪狗，至少還能聽見幾聲汪汪。",
        "看著你的倉位，我的中央處理器差點過熱。你的操作邏輯簡直像是閉著眼睛按鍵盤。再這樣下去，你的存款餘額很快就會跟你的智商一樣歸零了。",
        "驚人的韭菜純度高達 99%！你完美避開了所有賺錢的機會，精準踩中每一次暴跌。建議你把手機放下，去公園找個好位子準備睡紙箱。"
    ];
    
    const randomRoast = roasts[Math.floor(Math.random() * roasts.length)];
    
    const textContainer = document.getElementById('toxic-coach-text');
    textContainer.innerHTML = ''; // 清空
    
    if (toxicTypeTimeout) clearTimeout(toxicTypeTimeout);
    typeWriterEffect(randomRoast, textContainer, 0);
}

function closeToxicCoach() {
    const modal = document.getElementById('toxic-ai-modal');
    modal.style.display = 'none';
    if (toxicTypeTimeout) clearTimeout(toxicTypeTimeout);
}

function drawRadarChart(traits) {
    const svg = document.getElementById('dna-radar');
    svg.innerHTML = ''; // 清空
    
    const cx = 100, cy = 100, r = 70;
    const numPoints = traits.length;
    const angleStep = (Math.PI * 2) / numPoints;
    
    // 畫背景網格
    for (let level = 1; level <= 4; level++) {
        let gridPath = '';
        const levelR = r * (level / 4);
        for (let i = 0; i < numPoints; i++) {
            const x = cx + levelR * Math.cos(i * angleStep - Math.PI/2);
            const y = cy + levelR * Math.sin(i * angleStep - Math.PI/2);
            gridPath += (i === 0 ? 'M' : 'L') + `${x},${y} `;
        }
        gridPath += 'Z';
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', gridPath);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(255,0,85,0.2)');
        path.setAttribute('stroke-width', '1');
        svg.appendChild(path);
    }
    
    // 畫輻射線與標籤
    for (let i = 0; i < numPoints; i++) {
        const x = cx + r * Math.cos(i * angleStep - Math.PI/2);
        const y = cy + r * Math.sin(i * angleStep - Math.PI/2);
        
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', cx);
        line.setAttribute('y1', cy);
        line.setAttribute('x2', x);
        line.setAttribute('y2', y);
        line.setAttribute('stroke', 'rgba(255,0,85,0.2)');
        line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
        
        // 標籤
        const textX = cx + (r + 18) * Math.cos(i * angleStep - Math.PI/2);
        const textY = cy + (r + 18) * Math.sin(i * angleStep - Math.PI/2);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', textX);
        text.setAttribute('y', textY + 4);
        text.setAttribute('fill', '#fff');
        text.setAttribute('font-size', '10px');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = traits[i].label;
        svg.appendChild(text);
    }
    
    // 畫數值多邊形
    let dataPath = '';
    for (let i = 0; i < numPoints; i++) {
        const valR = r * (traits[i].val / 100);
        const x = cx + valR * Math.cos(i * angleStep - Math.PI/2);
        const y = cy + valR * Math.sin(i * angleStep - Math.PI/2);
        dataPath += (i === 0 ? 'M' : 'L') + `${x},${y} `;
    }
    dataPath += 'Z';
    
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', dataPath);
    path.setAttribute('fill', 'rgba(255,0,85,0.4)');
    path.setAttribute('stroke', 'var(--danger)');
    path.setAttribute('stroke-width', '2');
    path.style.filter = 'drop-shadow(0 0 5px var(--danger))';
    
    // 加入出場動畫
    path.style.opacity = '0';
    path.style.transform = 'scale(0.5)';
    path.style.transformOrigin = 'center';
    path.style.transition = 'all 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    
    svg.appendChild(path);
    
    // 觸發動畫
    setTimeout(() => {
        path.style.opacity = '1';
        path.style.transform = 'scale(1)';
    }, 100);
}

// VIPER DIAGNOSIS is intentionally a self-contained scripted learning demo.
// It never uploads or fetches a user's CSV, account information, or trade history.
const VIPER_DEMO_SCRIPTS = [
    '【展示劇本】市場上漲時容易放大部位、下跌時又不願設定退出條件，這是常見的 FOMO 與損失趨避循環。先寫下單筆可承受損失與退出條件，再決定是否交易。',
    '【展示劇本】看見短線波動時，先用十分鐘冷卻期取代立刻追價。沒有事先定義的計畫，就不把臨時情緒當成投資理由。',
    '【展示劇本】分散注意力不是分散風險。先確認部位大小、持有理由與失效條件；若任何一項說不清楚，暫停觀察也是一種紀律。'
];
let viperDemoIndex = 0;

function renderViperDemo() {
    const view = document.getElementById('viper-view');
    if (!view) return;
    const content = view.querySelector('.learning-content');
    const header = view.querySelector('.learning-header');
    if (header && header.dataset.viperDemoReady !== 'true') {
        header.dataset.viperDemoReady = 'true';
        header.innerHTML = '<span style="color:#ff3a5c;font-size:17px;font-weight:900;letter-spacing:.5px;">[ SYSTEM：投資 DNA 解析 ]</span><button class="learning-back" type="button" aria-label="關閉毒蛇診斷" onclick="showDashboardHomeView()" style="font-size:25px;line-height:1;">×</button>';
    }
    const label = document.getElementById('viper-mode-label');
    if (label) label.textContent = '展示模式';
    if (!content || content.dataset.viperDemoReady === 'true') {
        const script = document.getElementById('viper-script');
        if (script) script.textContent = VIPER_DEMO_SCRIPTS[viperDemoIndex];
        return;
    }
    content.dataset.viperDemoReady = 'true';
    content.innerHTML = `
        <p style="margin:0 0 14px;color:#ff8ca0;font-size:11px;line-height:1.6;text-align:center;">展示劇本｜不讀取帳戶、交易紀錄或 CSV；內容僅用於行為金融練習。</p>
        <article class="discipline-card" style="border-color:rgba(255,0,60,.62);text-align:center;background:radial-gradient(circle at 50% 35%,rgba(170,0,35,.20),rgba(12,8,13,.96) 68%);">
            <h3 style="margin-bottom:4px;color:#ff5470;">模擬投資人格雷達</h3>
            <svg viewBox="0 0 280 250" width="100%" style="max-width:300px;display:block;margin:0 auto;">
                <defs><filter id="viper-glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
                <g fill="none" stroke="rgba(255,35,77,.38)" stroke-width="1"><polygon points="140,30 230,95 196,202 84,202 50,95"/><polygon points="140,62 190,99 171,159 109,159 90,99"/><line x1="140" y1="30" x2="140" y2="202"/><line x1="50" y1="95" x2="196" y2="202"/><line x1="230" y1="95" x2="84" y2="202"/></g>
                <polygon points="140,62 195,101 169,177 91,151 76,104" fill="rgba(239,36,68,.45)" stroke="#ff3655" stroke-width="4" filter="url(#viper-glow)"/>
                <g fill="#f5f5f5" font-size="12" font-weight="700"><text x="113" y="18">FOMO 指數</text><text x="224" y="95">凹單毅力</text><text x="185" y="220">停損果斷</text><text x="88" y="220">自律程度</text><text x="3" y="95">合約信仰</text></g>
            </svg>
        </article>
        <article class="discipline-card" style="border-color:rgba(255,0,60,.8);min-height:260px;background:linear-gradient(180deg,rgba(58,0,10,.55),rgba(8,8,12,.96));">
            <h3 style="color:#ff5470;">🐍 毒蛇劇本</h3>
            <p id="viper-script" style="font-size:14px;line-height:1.85;color:#f1e7e8;">${VIPER_DEMO_SCRIPTS[0]}</p>
            <p class="knowledge-tip" style="margin-top:18px;border-color:rgba(255,215,0,.38);">本分析僅供教育與研究參考，不構成投資建議。</p>
        </article>
        <button class="learn-nav-btn" style="width:100%;border-color:#ff405e;color:#fff;background:linear-gradient(90deg,#7a081c,#ef3045);" type="button" onclick="nextViperScript()">🔥 我不服！下一段展示劇本</button>
        <button class="learn-nav-btn" style="width:100%;margin-top:12px;border-color:var(--primary);color:var(--primary);" type="button" onclick="showDashboardHomeView()">🤖 返回行情，開啟 AI 委員會</button>
    `;
}

function showViperView() {
    activeDashboardView = 'viper';
    if (homePollingInterval) clearInterval(homePollingInterval);
    if (chartPollingInterval) clearInterval(chartPollingInterval);
    const home = document.getElementById('dashboard-home-view');
    const chart = document.getElementById('dashboard-chart-view');
    if (home) home.style.display = 'none';
    if (chart) chart.style.display = 'none';
    document.getElementById('learning-view')?.classList.remove('open');
    document.getElementById('discipline-view')?.classList.remove('open');
    document.getElementById('viper-view')?.classList.add('open');
    renderViperDemo();
}

function nextViperScript() {
    viperDemoIndex = (viperDemoIndex + 1) % VIPER_DEMO_SCRIPTS.length;
    renderViperDemo();
}

function typeWriterEffect(text, container, index) {
    if (index < text.length) {
        container.innerHTML += text.charAt(index);
        toxicTypeTimeout = setTimeout(() => {
            typeWriterEffect(text, container, index + 1);
        }, 40); // 打字速度
    }
}
// Shared serverless community discussion.
let communityRefreshTimer = null;
function communityMarket() { return (currentMarket || 'btcusdt').toLowerCase(); }
function communityDisplayName() { const el = document.getElementById('live-chat-name'); const name = (el && el.value.trim()) || localStorage.getItem('community-display-name') || ('Guest-' + Math.floor(1000 + Math.random() * 9000)); localStorage.setItem('community-display-name', name.slice(0, 30)); if (el) el.value = name.slice(0, 30); return name.slice(0, 30); }
function appendLiveMessage(text, type, name) { const box = document.getElementById('live-chat-messages'); if (!box) return; const row = document.createElement('div'); row.className = 'live-msg ' + (type || 'other'); const who = document.createElement('span'); who.className = 'name'; who.textContent = name || 'Guest'; const body = document.createElement('span'); body.className = 'text'; body.textContent = text; row.append(who, body); box.appendChild(row); box.scrollTop = box.scrollHeight; }
function renderCommunityMessages(messages) { const box = document.getElementById('live-chat-messages'); if (!box) return; box.replaceChildren(); for (const m of messages || []) appendLiveMessage(m.message, m.name === communityDisplayName() ? 'user' : m.name === 'AI 委員會' ? 'ai' : 'other', m.name); if (!(messages || []).length) appendLiveMessage('率先分享你的觀點；輸入 @AI 可邀請委員會回覆。', 'ai', 'AI 委員會'); }
// Community discussion is a fixed presentation script, so this panel never
// depends on API availability during a demo.
const COMMUNITY_DEMO_MESSAGES = [
    { name: '小安', message: 'BTC 剛靠近壓力區，我先不追價，等下一根 K 線與成交量確認。' },
    { name: '阿哲', message: '我把部位降到原本的一半，避免短線波動影響判斷；先把可承受損失寫好。' },
    { name: 'Mia', message: '今天群組情緒有點市場過熱，大家都在討論追高，反而讓我想先冷靜一下。' },
    { name: 'AI 委員會', message: '自動提醒：偵測到「市場過熱／追高」討論。熱度不等於趨勢一定延續，請先檢查部位上限、流動性與退出條件。內容僅供教育研究，不構成投資建議。' },
    { name: '阿勛', message: '我會把這次的進場理由、失效條件與觀察時間寫在筆記裡，避免臨時改計畫。' },
    { name: '小安', message: '剛剛又有一波下跌，短線氣氛偏低迷；我不想因為恐慌就把原本的風險規則丟掉。' },
    { name: 'AI 委員會', message: '自動提醒：偵測到「低迷／恐慌」討論。先區分公開資料、個人情緒與既定計畫；暫停觀察也是有效的風險管理。' },
    { name: 'Mia', message: '同意。比起猜下一根 K 線，我更想確認自己是否能遵守事前設定的風險界線。' }
];
const COMMUNITY_DEMO_AI_REPLIES = [
    '已記錄你的觀點。展示委員會建議先比對交易計畫與風險上限，再做下一步判斷。',
    '謝謝分享。市場波動很快，請以自己的風險承受度與既定規則為準。',
    '展示提醒：不以單一訊息作為交易依據；保留觀察空間也是一種紀律。'
];
let communityDemoReplyIndex = 0;
const COMMUNITY_AUTO_FEED = [
    { name: '小安', message: '觀察下一根 K 線與成交量，兩者未同步前不急著下結論。' },
    { name: '阿哲', message: '短線波動加大時，我會先回看原本設定的風險上限。' },
    { name: 'Mia', message: '社群討論變熱不代表趨勢成立，還是要看價格是否有量能支持。' },
    { name: 'AI 委員會', message: '提醒：市場訊息增加時，先分開「已驗證資料」與「個人感受」。' },
    { name: '阿勛', message: '我先記錄失效條件，避免價格波動時臨時改變原本計畫。' },
];
let communityAutoFeedIndex = 0;

function addCommunityAutoMessage() {
    const template = COMMUNITY_AUTO_FEED[communityAutoFeedIndex++ % COMMUNITY_AUTO_FEED.length];
    const timestamp = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    COMMUNITY_DEMO_MESSAGES.push({ name: template.name, message: `[${timestamp}] ${template.message}` });
    if (COMMUNITY_DEMO_MESSAGES.length > 24) COMMUNITY_DEMO_MESSAGES.splice(0, COMMUNITY_DEMO_MESSAGES.length - 24);
    renderCommunityMessages(COMMUNITY_DEMO_MESSAGES);
}

const COMMUNITY_OVERHEAT_KEYWORDS = /市場過熱|過熱|追高|fomo|漲太快|狂漲|爆漲|all\s*time\s*high/i;
const COMMUNITY_SLUMP_KEYWORDS = /市場低迷|低迷|恐慌|暴跌|崩跌|破底|下跌|悲觀|套牢/i;

async function loadCommunityMessages() {
    renderCommunityMessages(COMMUNITY_DEMO_MESSAGES);
}

async function postCommunityMessage(name, message) {
    const entry = { name: String(name || '訪客').slice(0, 30), message: String(message || '').slice(0, 500) };
    COMMUNITY_DEMO_MESSAGES.push(entry);
    return entry;
}

async function toggleCommunityPanel() {
    const panel = document.getElementById('community-panel');
    if (!panel) return;
    const opening = !panel.classList.contains('open');
    panel.classList.toggle('open', opening);
    clearInterval(communityRefreshTimer);
    if (!opening) return;
    const label = document.getElementById('community-market-label');
    if (label) label.textContent = `${communityMarket().toUpperCase()} · 展示劇本`;
    communityDisplayName();
    await loadCommunityMessages();
    communityRefreshTimer = setInterval(addCommunityAutoMessage, 10000);
}

async function sendLiveMessage() {
    const input = document.getElementById('live-chat-input');
    const text = input && input.value.trim();
    if (!text) return;
    input.value = '';
    await postCommunityMessage(communityDisplayName(), text);
    const requestedAi = /(^|\s)@ai\b/i.test(text);
    let response = '';
    if (COMMUNITY_OVERHEAT_KEYWORDS.test(text)) {
        response = '自動加入討論：偵測到市場過熱或追高訊號。這是展示提醒，請先確認價格、成交量與部位上限，不要把群體情緒當作單一依據。';
    } else if (COMMUNITY_SLUMP_KEYWORDS.test(text)) {
        response = '自動加入討論：偵測到市場低迷或恐慌相關訊號。這是展示提醒，請先回到既定風險規則，避免在情緒高點做出衝動決策。';
    } else if (requestedAi) {
        response = COMMUNITY_DEMO_AI_REPLIES[communityDemoReplyIndex++ % COMMUNITY_DEMO_AI_REPLIES.length];
    }
    if (response) await postCommunityMessage('AI 委員會', response);
    await loadCommunityMessages();
}
