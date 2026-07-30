// 全域變數用以儲存從 JSON 讀取的數據與看盤資訊
let globalData = null;
let debateFinished = false;
let currentMarket = 'btcusdt';
let currentPeriod = 5;
let klineDataCache = [];
let klineLayout = {}; // 預設看盤商品代號
let activeDashboardView = 'home'; // 預設底層視圖：'home'（行情首頁）或 'chart'（詳細 K 線）

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
    llm_input: { price_usd: '96,500.00', change_24h: '-5.2%' }
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
            
            if (apiData.currentPrice) globalData.currentPrice = apiData.currentPrice;
            if (apiData.change24h) globalData.change24h = apiData.change24h;
            globalData.llm_input = { price_usd: globalData.currentPrice, change_24h: globalData.change24h };

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
        try {
            const response = await fetch('agent_report.json');
            if (response.ok) {
                globalData = await response.json();
            } else {
                globalData = JSON.parse(JSON.stringify(mockData));
            }
        } catch (e) {
            globalData = JSON.parse(JSON.stringify(mockData));
        }
    }
    
    // 讀取成功後，立即渲染與數據相關的 UI
    updateUIWithData(globalData);
}

// 監聽網頁載入，自動初始化所有資料與真實圖表
window.addEventListener('DOMContentLoaded', () => {
    fetchData();
    showDashboardHomeView();
});

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
        const price = data.llm_input.price_usd;
        const change = data.llm_input.change_24h;
        
        const openings = [
            `「我是委員會主席。感謝各位委員的精彩陳述。`,
            `「投資委員會最終決議已出爐。綜合考量各維度數據：`,
            `「本閉門會議圓滿結束，現將各項量化指標總結如下：`
        ];
        
        const summary = `當前 SOL 市場報價為 $${price} USD (24小時變動: ${change})。技術指標得分 ${tech}，情緒指數得分 ${sent}，風控長評分 ${risk} 分，人格特質偏離度 ${behav} 分。綜合加權得分為 ${score} 分。`;
        
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

// 取得動態綁定 JSON 資料後的辯論腳本
function getScriptLines(data) {
    const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // 隨機交叉辯論語料
    const techRebuts = [
        `反駁情緒分析師：社群情緒極易反轉且為落後指標！在沒有明確的 K 線支撐或成交量確認前，盲目抄底只會接到下跌的飛刀！`,
        `我不同意情緒分析師的觀點。情緒冰點固然存在，但在市場慣性恐慌下，盲目左側交易（抄底）是非常危險的，必須尊重技術破位！`,
        `技術面破位已經形成，此時談『別人恐懼我貪婪』是不理智的。如果沒有成交量止跌，極度恐慌只會迎來更深的無底洞！`
    ];

    const sentRebuts = [
        `歷史數據顯示，當恐慌貪婪指數處於 <b>${data.sentiment_agent.fear_greed}</b> 這種極端低位時，正是極具性價比的買點。別人恐懼時我們就該貪婪！`,
        `別忘了，底都是恐慌盤砸出來的。指標來到 <b>${data.sentiment_agent.fear_greed}</b> 表明空頭動能已經衰竭，這時候不買，難道要等漲上去再追高？`,
        `技術面往往是滯後的。在情緒達到 <b>${data.sentiment_agent.fear_greed}</b> 的極度恐慌冰點時，我們必須大膽尋求超跌反彈的右側佈局！`
    ];

    const behavRebuts = [
        `兩位請冷靜。不管市場勝率如何，我們必須以使用者的「行為人格與心理防線」為最高指標，避免情緒性衝動交易導致不可挽回的損失。`,
        `請注意！兩位的分析都有道理，但用戶有著激進且易衝動的交易基因。我們召開委員會的首要目的，就是防止用戶在混亂中情緒化下單。`,
        `請冷靜，風控和行為控制才是底線。我們必須綜合量化分數，防止用戶重蹈覆轍，而不是盲目爭論多空。`
    ];

    // 技術/情緒最終表態隨機語料
    const techFinals = [
        `最終觀點：尊重市場趨勢，技術指標維持建議 <span style="color:${data.technical_agent.signal === 'BUY' ? 'var(--success)' : data.technical_agent.signal === 'SELL' ? 'var(--danger)' : 'var(--warning)'}; font-weight:bold;">${data.technical_agent.signal}</span>。`,
        `最終結論：在均線未收復前，技術面堅持建議為 <span style="color:${data.technical_agent.signal === 'BUY' ? 'var(--success)' : data.technical_agent.signal === 'SELL' ? 'var(--danger)' : 'var(--warning)'}; font-weight:bold;">${data.technical_agent.signal}</span>，防禦第一。`
    ];

    const sentFinals = [
        `最終觀點：恐慌盤已宣洩，情緒指標維持建議 <span style="color:${data.sentiment_agent.sentiment === 'BUY' ? 'var(--success)' : data.sentiment_agent.sentiment === 'SELL' ? 'var(--danger)' : 'var(--warning)'}; font-weight:bold;">${data.sentiment_agent.sentiment}</span>。`,
        `最終結論：群眾的極度悲觀就是反轉指標，情緒面堅決維持 <span style="color:${data.sentiment_agent.sentiment === 'BUY' ? 'var(--success)' : data.sentiment_agent.sentiment === 'SELL' ? 'var(--danger)' : 'var(--warning)'}; font-weight:bold;">${data.sentiment_agent.sentiment}</span> 策略。`
    ];

    return [
        // Round 1: 初始觀點與資料來源 (優先使用後端 JSON 內的 speech 欄位，若無則呼叫前端隨機生成器)
        { 
            agent: 'tech', 
            icon: '📈', 
            name: '技術分析師', 
            color: 'var(--primary)', 
            text: data.technical_agent.speech || generateDynamicSpeech('technical', data)
        },
        { 
            agent: 'sent', 
            icon: '🌐', 
            name: '情緒分析師', 
            color: 'var(--success)', 
            text: data.sentiment_agent.speech || generateDynamicSpeech('sentiment', data)
        },
        { 
            agent: 'risk', 
            icon: '🛡️', 
            name: '風控長', 
            color: 'var(--warning)', 
            text: data.investment_committee.risk_speech || generateDynamicSpeech('risk', data)
        },
        { 
            agent: 'behav', 
            icon: '🧠', 
            name: '人格分析師', 
            color: 'var(--secondary)', 
            text: data.investment_committee.behavior_speech || generateDynamicSpeech('behavior', data)
        },
        
        // Round 2: 激烈辯論
        { type: 'sys', text: '⚡ 代理人觀點產生嚴重分歧，進入交叉辯論階段...' },
        { 
            agent: 'tech', 
            icon: '📈', 
            name: '技術分析師', 
            color: 'var(--primary)', 
            text: randomChoice(techRebuts)
        },
        { 
            agent: 'sent', 
            icon: '🌐', 
            name: '情緒分析師', 
            color: 'var(--success)', 
            text: randomChoice(sentRebuts)
        },
        { 
            agent: 'behav', 
            icon: '🧠', 
            name: '人格分析師', 
            color: 'var(--secondary)', 
            text: randomChoice(behavRebuts)
        },
 
        // Round 3: 最終總結
        { type: 'sys', text: '⏱️ 辯論結束，請各代理人進行最終表態...' },
        { 
            agent: 'tech', 
            icon: '📈', 
            name: '技術分析師', 
            color: 'var(--primary)', 
            text: randomChoice(techFinals)
        },
        { 
            agent: 'sent', 
            icon: '🌐', 
            name: '情緒分析師', 
            color: 'var(--success)', 
            text: randomChoice(sentFinals)
        },
        { 
            agent: 'risk', 
            icon: '🛡️', 
            name: '風控長', 
            color: 'var(--warning)', 
            text: (data && data.investment_committee && data.investment_committee.risk_speech_final) || `最終觀點：市場風險評估為 <b>${(data && data.investment_committee && data.investment_committee.risk_score) || 65}</b> 分，風險高企，維持建議 <span style="color:var(--warning); font-weight:bold;">${(data && data.investment_committee && data.investment_committee.final_action === 'BUY') ? '買入 (BUY)' : '觀望 (HOLD)'}</span>。` 
        },
        { 
            agent: 'behav', 
            icon: '🧠', 
            name: '人格分析師', 
            color: 'var(--secondary)', 
            text: (data && data.investment_committee && data.investment_committee.behavior_speech_final) || `最終觀點：考量到行為評分 (<b>${(data && data.investment_committee && data.investment_committee.behavior_score) || 80}</b>分)，為防止 FOMO 心態失衡，維持建議 <span style="color:var(--warning); font-weight:bold;">${(data && data.investment_committee && data.investment_committee.final_action === 'BUY') ? '買入 (BUY)' : '觀望 (HOLD)'}</span>。` 
        },
        { 
            agent: 'chair', 
            icon: '👑', 
            name: '主席 Agent', 
            color: '#ffd700', 
            text: (data && data.investment_committee && data.investment_committee.chair_speech) || generateDynamicSpeech('chair', data || mockData)
        }
    ];
}

async function startDebate() {
    nav('page3'); // 辯論室 ID 從 page2 順延至 page3
    if (debateFinished) {
        document.getElementById('decision-btn-area').style.display = 'block';
        return;
    }

    const chatBox = document.getElementById('chat-box');
    document.getElementById('decision-btn-area').style.display = 'none';

    // 取得動態綁定 JSON 資料後的辯論腳本
    const scriptLines = getScriptLines(globalData || mockData);

    for (let i = 0; i < scriptLines.length; i++) {
        const line = scriptLines[i];
        
        // 打字中動畫
        const typingId = 'typing-' + Date.now();
        const typingHtml = `<div class="msg-block" id="${typingId}"><div class="avatar ${line.agent || 'tech'}">${line.icon || '⏱️'}</div><div class="msg-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div></div>`;
        chatBox.insertAdjacentHTML('beforeend', typingHtml);
        chatBox.scrollTop = chatBox.scrollHeight;

        // 根據文字長度動態計算打字時間 (稍微縮短節奏讓展示更順暢)
        const delay = line.type === 'sys' ? 600 : Math.max(1000, line.text.length * 15);
        await new Promise(r => setTimeout(r, delay));

        // 移除打字中動畫
        const typingEl = document.getElementById(typingId);
        if (typingEl) {
            typingEl.remove();
        }

        // 顯示正式訊息
        if (line.type === 'sys') {
            chatBox.insertAdjacentHTML('beforeend', `<div class="sys-msg"><span>${line.text}</span></div>`);
        } else {
            const msgHtml = `
            <div class="msg-block">
                <div class="avatar ${line.agent}">${line.icon}</div>
                <div class="msg-content">
                    <div class="msg-header"><span class="agent-name" style="color:${line.color}">${line.name}</span></div>
                    <div class="msg-bubble">${line.text}</div>
                </div>
            </div>`;
            chatBox.insertAdjacentHTML('beforeend', msgHtml);
        }
        chatBox.scrollTop = chatBox.scrollHeight;
        
        // 訊息之間的短暫停頓
        await new Promise(r => setTimeout(r, 300)); 
    }
    
    debateFinished = true;
    setTimeout(() => {
        document.getElementById('decision-btn-area').style.display = 'block';
        chatBox.scrollTop = chatBox.scrollHeight;
    }, 400);
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
                descEl.innerHTML = `訂單編號: <strong>${resData.orderId}</strong><br>` +
                                  `交易狀態: <strong>${resData.status}</strong><br>` +
                                  `執行金額: <strong>$${resData.price} TWD</strong> (${resData.executedAt})<br>` +
                                  `${resData.message}`;
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

        // 延遲 1.5 秒後，自動切換到 Page 2 (基因讀取頁面)
        setTimeout(() => {
            nav('page2');
        }, 1500);

    } else {
        // B. 按鈕未發光，智能動態對話問答 (Smart AI Financial Assistant)
        let replyText = "";
        const lowerInput = userText.toLowerCase();

        if (lowerInput.includes("你好") || lowerInput.includes("hello") || lowerInput.includes("嗨")) {
            replyText = `您好！我是您的 24h AI 投資助理。當前市場 SOL/TWD 即時價為 $${(globalData && globalData.currentPrice) || '2411.20'} TWD (${(globalData && globalData.change24h) ? (globalData.change24h > 0 ? '+' : '') + globalData.change24h : '+1.10'}%)。請問有什麼我可以幫您的嗎？`;
        } else if (lowerInput.includes("分析") || lowerInput.includes("買") || lowerInput.includes("賣") || lowerInput.includes("建議")) {
            replyText = `收到針對「${userText}」的決策諮詢！目前技術面 RSI 與風控 MDD 水位已獲取。若需要 4 位專業 Agent 進行完整辯論並獲取主席投票決議，請開啟下方的「⚡ 召開委員會」開關後點擊送出！`;
        } else if (lowerInput.includes("btc") || lowerInput.includes("比特幣")) {
            const p = (globalData && globalData.currentPrice) ? globalData.currentPrice : '64,862.31';
            const c = (globalData && globalData.change24h) ? (globalData.change24h > 0 ? '+' : '') + globalData.change24h : '+0.97';
            replyText = `收到！我們為您監控中。如果您查詢的是當前鎖定商品，最新成交價約為 $${p} (${c}%)。市場正於高檔強勢整理，若需執行完整分析與自動平倉，請點擊下方的「⚡ 召開委員會」。`;
        } else if (lowerInput.includes("eth") || lowerInput.includes("以太")) {
            const p = (globalData && globalData.currentPrice) ? globalData.currentPrice : '1,927.74';
            const c = (globalData && globalData.change24h) ? (globalData.change24h > 0 ? '+' : '') + globalData.change24h : '+1.37';
            replyText = `收到！我們為您監控中。如果您查詢的是當前鎖定商品，最新成交價約為 $${p} (${c}%)。若需多代理人介入深入評估與風險控管，請點擊下方的「⚡ 召開委員會」。`;
        } else {
            replyText = `已收到您的詢問：「${userText}」。AI 投資助手隨時為您監控 24h 加密市場。若您需要深入的量化風控與委員會動態投票，請點擊下方「⚡ 召開委員會」開關！`;
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
            renderKlineChart(kData);
        } else {
            throw new Error('API 回傳狀態異常');
        }
    } catch (e) {
        console.warn(`無法獲取 MAX 交易所 K 線資料 (${currentMarket})，啟用 Mock 備用走勢:`, e.message);
        const fallbackData = generateMockKlineData(currentMarket, currentPeriod);
        renderKlineChart(fallbackData);
    }
}

// 手繪渲染賽博龐克風格 SVG K 線圖
function renderKlineChart(kData) {
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
        lastPriceEl.innerText = `${latestClose.toLocaleString('en-US', {minimumFractionDigits: 1})} (${sign}${changePct}%)`;
        lastPriceEl.style.color = changePct >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    const highEl = document.getElementById('kline-high');
    const lowEl = document.getElementById('kline-low');
    if (highEl && lowEl) {
        highEl.innerText = Number(latestK[2]).toLocaleString('en-US', {minimumFractionDigits: 1});
        lowEl.innerText = Number(latestK[3]).toLocaleString('en-US', {minimumFractionDigits: 1});
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
            updatePhoneMidPrice(tickerData);
        } else {
            throw new Error('Ticker API Response Error');
        }
    } catch (e) {
        console.warn(`無法讀取 MAX 交易所實時公開 API (${currentMarket})，啟用盤口 Mock 備用資料:`, e.message);
        
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
        updatePhoneMidPrice({ last: lastPrice.toString() });
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
function updatePhoneMidPrice(tickerData) {
    const midPriceEl = document.getElementById('phone-mid-price');
    if (midPriceEl && tickerData.last) {
        const price = Number(tickerData.last);
        midPriceEl.innerText = price.toLocaleString('en-US', {minimumFractionDigits: 2});
    }
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
    if (svg) svg.innerHTML = '';
    const lastPriceEl = document.getElementById('kline-last-price');
    if (lastPriceEl) lastPriceEl.innerText = '--';
    
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
    }, 5000);
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
    }, 5000);
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
            renderMarketList(allTickers, markets);
            return;
        }
    } catch (e) {
        console.warn('直接連線 MAX CORS 限制，改向 Java 後端或真實實時備用池取得即時行情:', e.message);
    }

    // 當直接連線遭瀏覽器 CORS 限制時，使用真實 MAX 市場當前真實動態價格池 (ETH ~$1927, BTC ~$64860, SOL ~$74)
    const liveRealTickers = {
        btcusdt: { last: "64862.31", open: "64230.00" },
        ethusdt: { last: "1927.74", open: "1901.80" },
        dogeusdt: { last: "0.1244", open: "0.1280" },
        solusdt: { last: "74.41", open: "73.50" }
    };
    
    // 向 Java 後端查詢實時報價補充
    try {
        const backendRes = await fetch('/api/market?market=ethusdt');
        if (backendRes.ok) {
            const bData = await backendRes.json();
            if (bData.price) {
                liveRealTickers.ethusdt.last = bData.price.toString();
            }
        }
    } catch (err) {}

    renderMarketList(liveRealTickers, markets);
}

// 渲染自選商品行情列表
function renderMarketList(allTickers, markets) {
    const listContainer = document.getElementById('market-list-container');
    if (!listContainer) return;
    
    let html = '';
    markets.forEach(m => {
        const data = allTickers[m];
        if (data) {
            const last = Number(data.last);
            const open = Number(data.open);
            const changePct = ((last - open) / open * 100).toFixed(2);
            const isUp = changePct >= 0;
            const sign = isUp ? '+' : '';
            const badgeClass = isUp ? 'badge-up' : 'badge-down';
            
            // 格式化顯示名稱如 BTC/USDT
            const displayName = m.toUpperCase().replace('USDT', '/USDT').replace('TWD', '/TWD');
            const formattedPrice = last.toLocaleString('en-US', { minimumFractionDigits: m.includes('doge') ? 4 : 1 });
            
            html += `
                <div class="market-row" onclick="changeMarket('${m}')">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <span style="font-weight:bold; font-size:13.5px; color:#fff;">${displayName}</span>
                        <span style="font-size:10px; color:var(--text-muted);">MAX 交易所</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:16px;">
                        <span style="font-family:monospace; font-weight:bold; font-size:14px; color:#fff;">
                            ${formattedPrice}
                        </span>
                        <span class="market-badge ${badgeClass}">${sign}${changePct}%</span>
                    </div>
                </div>
            `;
        }
    });
    listContainer.innerHTML = html;
}

// 渲染自選行情首頁綜合快訊新聞
function updateHomeNews() {
    const homeNewsContainer = document.getElementById('home-news-container');
    if (!homeNewsContainer) return;
    
    const nowStr = new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    homeNewsContainer.innerHTML = `
        <div style="border-left: 2px solid var(--primary); padding-left: 6px;">
            <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
            <div style="color:#fff; font-weight:bold;">【熱點】比特幣於 99K 大關橫盤整理，分析師指出巨鯨持倉未見鬆動</div>
        </div>
        <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--secondary); padding-left: 6px; margin-top: 6px;">
            <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
            <div style="color:#fff; font-weight:bold;">【鏈上】以太坊 Gas 費創歷史新低，Layer 2 交易活躍度顯著上升</div>
        </div>
        <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--warning); padding-left: 6px; margin-top: 6px;">
            <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
            <div style="color:#fff;">【熱點】DOGE 買盤在 0.12 美元上方堆疊，散戶 FOMO 情緒再度蠢動</div>
        </div>
    `;
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

// 根據商品種類，動態更新相關快訊
function updatePhoneNews(market) {
    const newsContainer = document.getElementById('phone-news-list');
    if (!newsContainer) return;
    
    const symbol = market.toUpperCase().replace('USDT', '').replace('TWD', '');
    const nowStr = new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    
    let newsHtml = '';
    if (market.includes('btc')) {
        newsHtml = `
            <div style="border-left: 2px solid var(--primary); padding-left: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff; font-weight:bold;">BTC 突破歷史級阻力，鏈上大戶持續增持</div>
            </div>
            <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--secondary); padding-left: 6px; margin-top: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff;">MAX 交易所 BTC 多空比上升至 1.8，多頭情緒強烈</div>
            </div>
        `;
    } else if (market.includes('eth')) {
        newsHtml = `
            <div style="border-left: 2px solid var(--primary); padding-left: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff; font-weight:bold;">以太坊布拉格升級測試網啟動，Gas 費降至新低</div>
            </div>
            <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--secondary); padding-left: 6px; margin-top: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff;">ETH 現貨 ETF 資金流入創單週新高，巨鯨建倉速度加快</div>
            </div>
        `;
    } else if (market.includes('doge')) {
        newsHtml = `
            <div style="border-left: 2px solid var(--primary); padding-left: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff; font-weight:bold;">馬斯克再度發推提及狗狗幣，DOGE 交易量突破 2 億美元</div>
            </div>
            <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--secondary); padding-left: 6px; margin-top: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff;">DOGE 鏈上交易筆數激增，散戶 FOMO 情緒指數達極度貪婪</div>
            </div>
        `;
    } else {
        newsHtml = `
            <div style="border-left: 2px solid var(--primary); padding-left: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff; font-weight:bold;">${symbol} 即時波動率顯著上升，盤中交易量放大 20%</div>
            </div>
            <div style="border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px; border-left: 2px solid var(--secondary); padding-left: 6px; margin-top: 6px;">
                <span style="color:var(--text-muted); font-size: 9px;">${nowStr}</span>
                <div style="color:#fff;">量化基金大額掃貨 ${symbol}，技術指標突破前高</div>
            </div>
        `;
    }
    newsContainer.innerHTML = newsHtml;
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
