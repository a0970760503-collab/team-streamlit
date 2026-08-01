let currentTopic = '';
// 全域變數用以儲存從 JSON 讀取的數據與看盤資訊
let globalData = null;
let debateFinished = false;
let currentMarket = 'btcusdt';
let currentPeriod = 5;
let klineDataCache = [];
let klineLayout = {}; // 預設看盤商品代號
let activeDashboardView = 'home'; // 預設底層視圖：'home'（行情首頁）或 'chart'（詳細 K 線）

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
async function fetchData() {
    try {
        // 優先嘗試向 Java / Python 後端 8080 埠請求最新行情與動態 Agent 分析
        const response = await fetch('/api/report');
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
        const response = await fetch('/api/news?_t=' + new Date().getTime());
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

function getScriptLines(data) {
    return [
        { 
            agent: 'tech', icon: '📈', name: '技術分析師', color: 'var(--primary)', 
            text: data.technical_agent.speech || "技術面資料載入中..."
        },
        { 
            agent: 'sent', icon: '🌐', name: '情緒分析師', color: 'var(--success)', 
            text: data.sentiment_agent.speech || "情緒面資料載入中..."
        },
        { 
            agent: 'risk', icon: '🛡️', name: '風控長', color: 'var(--warning)', 
            text: data.investment_committee.risk_speech || "風控資料載入中..."
        },
        { 
            agent: 'behav', icon: '🧠', name: '人格分析師', color: 'var(--secondary)', 
            text: data.investment_committee.behavior_speech || "行為資料載入中..."
        }
    ];
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

async function startDebate(initialUserText = null) {
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
        // 動態生成辯論
        debateHistory.push({ name: "人類用戶", text: initialUserText, role: "user" });
        await renderChatMessage({ agent: 'chair', icon: '👤', name: '人類用戶', color: '#fff', text: initialUserText });
        
        try {
            const response = await fetch('/api/chat_debate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history: debateHistory, topic: currentTopic || currentMarket })
            });
            const resData = await response.json();
            
            if (resData && resData.debates) {
                for (let reply of resData.debates) {
                    debateHistory.push({ name: reply.name, text: reply.text, role: "agent" });
                    await renderChatMessage(reply);
                }
            }
        } catch (e) {
            console.error("Chat Debate Error:", e);
            await renderChatMessage({ type: 'sys', text: `連線異常: ${e}` });
        }
    } else {
        // 預設靜態生成
        const scriptLines = getScriptLines(globalData || mockData);
        for (let i = 0; i < scriptLines.length; i++) {
            debateHistory.push({ name: scriptLines[i].name, text: scriptLines[i].text, role: "agent" });
            await renderChatMessage(scriptLines[i]);
        }
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
        const response = await fetch('/api/chat_debate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: debateHistory, topic: currentTopic || currentMarket })
        });
        const resData = await response.json();
        
        if (resData && resData.debates) {
            for (let reply of resData.debates) {
                debateHistory.push({ name: reply.name, text: reply.text, role: "agent" });
                await renderChatMessage(reply);
            }
        }
    } catch (e) {
        console.error("Chat Debate Error:", e);
        await renderChatMessage({ type: 'sys', text: `連線異常: ${e}` });
    }
    
    document.getElementById('debate-action-btns').style.display = 'flex';
}

async function endDebate() {
    document.getElementById('decision-btn-area').style.display = 'none';
    await renderChatMessage({ type: 'sys', text: '⏱️ 辯論結束，主席正在彙整最終共識...' });
    
    try {
        const response = await fetch('/api/conclude_debate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: debateHistory, topic: currentTopic || currentMarket })
        });
        const resData = await response.json();
        
        // Render Chair Summary in chat before navigating
        await renderChatMessage({ agent: 'chair', icon: '👑', name: '主席 Agent', color: '#ffd700', text: resData.summary });
        await new Promise(r => setTimeout(r, 1500));
        
        // Populate Page 4 UI
        if (globalData && globalData.investment_committee) {
            globalData.investment_committee.final_action = resData.final_action;
        } else {
            globalData = { investment_committee: { final_action: resData.final_action } };
        }
        updateUIWithData(globalData);
        nav('page4');
        
    } catch (e) {
        console.error("Conclude Debate Error:", e);
        await renderChatMessage({ type: 'sys', text: `結案連線異常: ${e}` });
        document.getElementById('decision-btn-area').style.display = 'flex';
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
    try {
        const btnEl = document.getElementById('order-btn-p5');
        if (btnEl) btnEl.innerText = '⌛ 正在連線 MAX API 發起下單...';

        const response = await fetch('/api/trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                market: 'soltwd',
                side: 'buy',
                volume: 1.0
            })
        });

        if (response.ok) {
            const resData = await response.json();
            console.log('✅ 雙向數據流下單成功:', resData);
            const descEl = document.getElementById('success-desc-p5');
            if (descEl) {
                if (resData.success === false || resData.price === null || resData.price === undefined) {
                    // P10：報價不可用而中止委託時，不得顯示任何成交金額
                    markDataSource('下單報價', 'unavailable', resData.error || '報價不可用，委託已中止');
                    descEl.innerHTML = `交易狀態: <strong>${resData.status || '已中止'}</strong><br>` +
                                       `執行金額: <strong>${PRICE_UNAVAILABLE}</strong><br>` +
                                       `${resData.message || '即時報價不可用，未送出任何委託。'}`;
                } else {
                    markDataSource('下單報價', 'live');
                    descEl.innerHTML = `訂單編號: <strong>${resData.orderId}</strong><br>` +
                                       `交易狀態: <strong>${resData.status}</strong><br>` +
                                       `執行金額: <strong>$${resData.price} TWD</strong> (${resData.executedAt})<br>` +
                                       `${resData.message}`;
                }
            }
        }
    } catch (e) {
        console.warn('雙向數據流下單 API 呼叫失敗，改為本地模擬觸發:', e);
    }
    
    document.getElementById('success').style.display = 'flex';
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

        try {
            const res = await fetch('/api/extract_topic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: userText })
            });
            const data = await res.json();
            if (data.topic) {
                currentTopic = data.topic.toUpperCase();
            }
        } catch (e) {
            console.error("Extract topic error:", e);
        }

        // 直接啟動辯論 Tab
        setTimeout(() => {
            startDebate(userText);
            document.getElementById('committee-switch').classList.remove('active-neon');
        }, 1500);

    } else {
        // B. 按鈕未發光，智能動態對話問答 (Smart AI Financial Assistant)
        let replyText = "連線異常，無法回應。";
        try {
            const res = await fetch('/api/chat_assistant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: userText, topic: currentTopic || currentMarket })
            });
            const data = await res.json();
            if (data.text) {
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

// 抓取 MAX 交易所真實 K 線走勢資料 (最近 35 根 15 分鐘線，具備 Mock 容錯機制)
async function fetchMaxKlineData() {
    try {
        const res = await fetch(`/api/proxy?path=/api/v2/k&market=${currentMarket}&limit=35&period=${currentPeriod}`);
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
        const depthRes = await fetch(`/api/proxy?path=/api/v2/depth&market=${currentMarket}&limit=10`);
        if (depthRes.ok) {
            const depthData = await depthRes.json();
            updatePhoneOrderBook(depthData);
        } else {
            throw new Error('Depth API Response Error');
        }

        // 2. 獲取即時成交價 (MAX Open API)
        const tickerRes = await fetch(`/api/proxy?path=/api/v2/tickers/${currentMarket}`);
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
    if (homeView) homeView.style.display = 'flex';
    if (chartView) chartView.style.display = 'none';
    
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
    if (homeView) homeView.style.display = 'none';
    if (chartView) chartView.style.display = 'flex';
    
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

// 抓取多檔自選代幣即時報價 (對接 MAX 官方 Tickers API，具備 Mock 容錯)
async function fetchMaxAllTickers() {
    const listContainer = document.getElementById('market-list-container');
    if (!listContainer) return;
    
    const markets = ['btcusdt', 'ethusdt', 'dogeusdt', 'solusdt'];
    try {
        const res = await fetch('/api/proxy?path=/api/v2/tickers');
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
        const backendRes = await fetch('/api/market?market=soltwd');
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
        const response = await fetch('/api/news?_t=' + new Date().getTime());
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
        const response = await fetch(`/api/news?market=${symbol}`);
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

function typeWriterEffect(text, container, index) {
    if (index < text.length) {
        container.innerHTML += text.charAt(index);
        toxicTypeTimeout = setTimeout(() => {
            typeWriterEffect(text, container, index + 1);
        }, 40); // 打字速度
    }
}
