import os
import re

APP_JS = r"web/app.js"
INDEX_HTML = r"web/index.html"
START_DEMO = r"start_demo.py"

def patch_file(path, old_text, new_text):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if old_text in content:
        content = content.replace(old_text, new_text)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Patched {path}")
    else:
        print(f"Target not found in {path}")

def main():
    # 1. Update index.html to add Tabs inside Page 1 and merge Page 3 into Page 1
    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        html = f.read()

    # Create Tabs inside Page 1 header
    old_header = """<div class="cyber-header" style="margin-top: 10px; margin-bottom: 10px; flex-shrink: 0;">
                <h2>> AI 投資助理</h2>
                <p style="font-size: 13px; color: var(--text-muted); margin:0;">即時一般問答 / ⚡召開委員會深度分析</p>
            </div>"""
            
    new_header = """<div class="cyber-header" style="margin-top: 10px; margin-bottom: 10px; flex-shrink: 0; display:flex; flex-direction:column; gap:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h2>> AI 互動中心</h2>
                </div>
                <div style="display:flex; gap:10px;">
                    <button id="tab-btn-assistant" onclick="switchTab('assistant')" style="flex:1; padding:8px; border:1px solid var(--primary); background:rgba(112,0,255,0.2); color:#fff; border-radius:5px; cursor:pointer;">對話助理</button>
                    <button id="tab-btn-debate" onclick="switchTab('debate')" style="flex:1; padding:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:var(--text-muted); border-radius:5px; cursor:pointer; display:none;">⚡ 委員會</button>
                </div>
            </div>"""

    if old_header in html:
        html = html.replace(old_header, new_header)
        
    # Wrap Chat Box
    old_chat = """<!-- 對話區 -->
            <div class="chat-container" id="assistant-chat-box" style="flex: 1; margin-bottom: 20px; padding-bottom: 0;">"""
            
    new_chat = """<!-- 對話區 (Tab 1: Assistant) -->
            <div class="chat-container" id="assistant-chat-box" style="flex: 1; margin-bottom: 20px; padding-bottom: 0; display:flex;">"""
            
    if old_chat in html:
        html = html.replace(old_chat, new_chat)

    # Wrap Debate Box inside Page 1 (Moving Page 3 content into Page 1)
    old_input_area = """<!-- 底部控制欄：左邊是滑桿開關，右邊是送出按鈕 -->"""
    
    new_debate_tab = """<!-- 辯論區 (Tab 2: Debate) -->
            <div class="chat-container" id="debate-chat-box" style="flex: 1; margin-bottom: 20px; padding-bottom: 0; display:none; flex-direction:column;">
                <div class="sys-msg" id="debate-sys-msg"><span>🚨 系統警報：已啟動緊急辯論會議</span></div>
                <div id="debate-messages-container" style="flex:1; overflow-y:auto; margin-top:10px; margin-bottom:10px;"></div>
                
                <div class="decision-btn-container" id="decision-btn-area" style="display:none; flex-direction:column; gap:10px;">
                    <div id="debate-input-area" style="display:none; flex-direction:column; gap:8px;">
                        <input type="text" id="debate-input" placeholder="輸入您的觀點或指定幣種..." style="width:100%; padding:12px; border-radius:8px; background:rgba(0,0,0,0.8); border:1px solid var(--primary); color:#fff;" onkeydown="if(event.key==='Enter') sendDebateMsg()">
                        <button class="glow-btn" style="margin:0; padding:10px; font-size:14px;" onclick="sendDebateMsg()">發送觀點</button>
                    </div>
                    <div id="debate-action-btns" style="display:flex; gap:10px; width:100%;">
                        <button class="glow-btn" style="margin: 0; background:var(--bg-chat); border:1px solid var(--primary); color:var(--primary); box-shadow:none; flex:1;" onclick="toggleDebateInput()">🙋 加入討論</button>
                        <button class="glow-btn" style="margin: 0; box-shadow: 0 0 20px rgba(112, 0, 255, 0.6); flex:1;" onclick="endDebate()">⚡ 結束辯論</button>
                    </div>
                </div>
            </div>
            
            <!-- 底部控制欄：左邊是滑桿開關，右邊是送出按鈕 -->"""
            
    if old_input_area in html and "debate-chat-box" not in html:
        html = html.replace(old_input_area, new_debate_tab)

    # Completely hide page3 in index.html to prevent duplicate IDs
    if '<div id="page3" class="page"' in html:
        html = html.replace('<div id="page3" class="page"', '<div id="page3" class="page" style="display:none !important;"')
        
    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    print("Patched index.html")

    # 2. Update app.js
    with open(APP_JS, "r", encoding="utf-8") as f:
        js = f.read()
        
    # Inject switchTab function and global topic
    if "let currentTopic = '';" not in js:
        js = "let currentTopic = '';\n" + js
        
    tab_funcs = """
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
"""
    if "function switchTab(" not in js:
        js += tab_funcs

    # Fix startDebate
    old_startDebate = """async function startDebate() {
    nav('page3'); 
    if (debateFinished) {
        document.getElementById('decision-btn-area').style.display = 'flex';
        return;
    }"""
    
    new_startDebate = """async function startDebate() {
    // 顯示 Tab 並且切換過去
    document.getElementById('tab-btn-debate').style.display = 'block';
    switchTab('debate');
    
    if (debateFinished) {
        document.getElementById('decision-btn-area').style.display = 'flex';
        return;
    }
    
    // 設定標題，讓用戶知道當前討論的幣種
    document.getElementById('debate-sys-msg').innerHTML = `<span>🚨 系統警報：已針對 ${currentTopic || currentMarket} 啟動緊急辯論會議</span>`;
"""
    if old_startDebate in js:
        js = js.replace(old_startDebate, new_startDebate)

    # Fix renderChatMessage to append to correct container during debate
    old_render = """const chatBox = document.getElementById('chat-box');
    chatBox.insertAdjacentHTML('beforeend', msgHtml);
    chatBox.scrollTop = chatBox.scrollHeight;"""
    
    new_render = """const container = (msg.type === 'sys' || debateHistory.length > 0) ? document.getElementById('debate-messages-container') : document.getElementById('chat-box');
    if (container) {
        container.insertAdjacentHTML('beforeend', msgHtml);
        container.parentElement.scrollTop = container.parentElement.scrollHeight;
    }"""
    if old_render in js:
        js = js.replace(old_render, new_render)
        
    # Track topic in assistant
    old_assistant = """const lowerInput = userText.toLowerCase();"""
    new_assistant = """const lowerInput = userText.toLowerCase();
    
    // 從對話中擷取潛在幣種
    const coins = ['btc', 'eth', 'sol', 'doge', 'bnb', 'xrp'];
    for(let c of coins) {
        if (lowerInput.includes(c)) currentTopic = c.toUpperCase();
    }
"""
    if old_assistant in js:
        js = js.replace(old_assistant, new_assistant)

    # API Payloads
    js = js.replace("body: JSON.stringify({ history: debateHistory })", "body: JSON.stringify({ history: debateHistory, topic: currentTopic || currentMarket })")
    
    # Do not auto-navigate to page2 when toggle is on. Just start debate!
    old_page2 = """// 延遲 1.5 秒後，自動切換到 Page 2 (基因讀取頁面)
        setTimeout(() => {
            nav('page2');
        }, 1500);"""
    
    new_page2 = """// 直接啟動辯論 Tab
        setTimeout(() => {
            startDebate();
            document.getElementById('committee-switch').classList.remove('active-neon');
        }, 1500);"""
    if old_page2 in js:
        js = js.replace(old_page2, new_page2)

    with open(APP_JS, "w", encoding="utf-8") as f:
        f.write(js)
    print("Patched app.js")

    # 3. Update start_demo.py
    with open(START_DEMO, "r", encoding="utf-8") as f:
        py = f.read()
        
    # Update prompt inside chat_debate
    old_prompt1 = """prompt = f\"\"\"
請你扮演四個 AI 投資代理人之一。"""
    
    new_prompt1 = """topic = payload.get("topic", "目前鎖定的加密貨幣")
        prompt = f\"\"\"
現在正在討論的投資標的是：【{topic}】。
請你針對該標的（{topic}），扮演 AI 投資代理人參與辯論。"""
    if old_prompt1 in py:
        py = py.replace(old_prompt1, new_prompt1)
        
    old_prompt2 = """prompt = f\"\"\"
你現在是 AI 投資委員會的主席 (Chair)。"""
    new_prompt2 = """topic = payload.get("topic", "目前鎖定的加密貨幣")
        prompt = f\"\"\"
你現在是 AI 投資委員會的主席 (Chair)。你們剛才針對【{topic}】進行了激烈的辯論。"""
    if old_prompt2 in py:
        py = py.replace(old_prompt2, new_prompt2)
        
    with open(START_DEMO, "w", encoding="utf-8") as f:
        f.write(py)
    print("Patched start_demo.py")

if __name__ == "__main__":
    main()
