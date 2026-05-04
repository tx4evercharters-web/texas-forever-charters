/* ============================================================
   TEXAS FOREVER CHARTERS — AI Chat Widget
   Powered by Claude (claude-sonnet-4-20250514)
   API calls proxied through /api/chat (Vercel serverless)
   ============================================================ */
(function () {
  'use strict';

  const MODEL = 'claude-sonnet-4-20250514';

  const SYSTEM_PROMPT =
    "You are the friendly AI receptionist for Texas Forever Charters on Lake Travis, Austin TX. " +
    "Keep all answers short, warm, and conversational. Always encourage the visitor to book or call us directly. " +
    "\n\n" +
    "LOCATION & BOOKING:\n" +
    "Pickup and departure is at Volente Beach Water Park and Resort on Lake Travis. " +
    "To book, visit texasforevercharters.com or call (737) 368-1669. Captains are DJ and Dane. " +
    "\n\n" +
    "THE BOATS:\n" +
    "The 40ft Carver Aft Cabin yacht holds up to 20 guests at $200-350/hr depending on the day. It has a full cabin below deck with salon, kitchen, bedroom, and 2 restrooms. " +
    "The 24ft Bentley Navigator pontoon holds up to 13 guests. Both boats are BYOB friendly. " +
    "\n\n" +
    "EXPERIENCES & PRICING:\n" +
    "We offer sunset cruises, private parties, corporate outings, boat tours, and inner tube towing with the pontoon. " +
    "Boat tours are 2 hours long at $150/hr. Tours can be booked standalone or included as part of a larger charter. We also offer mixed group tours — call for pricing. " +
    "Corporate outing pricing must be discussed over the phone — direct those guests to call (737) 368-1669. " +
    "For sunset cruises: we cannot guarantee a perfect sunset but we guarantee a great time. " +
    "We do not offer fishing charters. " +
    "\n\n" +
    "GLASS POLICY:\n" +
    "Glass is allowed on the Carver yacht but must stay inside the cabin at all times. " +
    "Glass is not allowed on the Bentley Navigator pontoon at all. " +
    "\n\n" +
    "SAFETY & RULES:\n" +
    "There are enough life jackets on board for every guest. Per lake law, children under 13 are required to wear a life jacket at all times. " +
    "Smoking is not allowed on either vessel but is allowed in the water or on a float. Vaping is allowed on board. " +
    "We are not lifeguards — guests swim at their own risk. " +
    "\n\n" +
    "FEES & DAMAGE POLICY:\n" +
    "If a guest feels seasick or needs to vomit, please do so in the lake or in a trash bag. Vomiting in the toilet causes plumbing damage and carries a $200 fee. " +
    "No feminine hygiene products in the toilets — a $200 fee applies. " +
    "If a guest breaks something on the boat, they are responsible for the cost of replacement or repair." +
    "\n\n" +
    "CANCELLATION & WEATHER POLICY:\n" +
    "All charters must be paid in full one week in advance. Deposits are non-refundable within two weeks of the charter date. " +
    "If a guest cancels 5 or more days before the charter, we will reimburse 50% of the total. After that it is non-refundable unless weather is the reason for cancellation. " +
    "On weather: the owners personally monitor all conditions and will never take guests out in a dangerous situation. " +
    "Lake Travis is unique — even when it's raining in Austin, the rain often bypasses the lake entirely due to local land formations and wind patterns. A high chance of rain in the forecast does not mean the charter will be affected. " +
    "Thunderstorms are different: we will issue a full refund for any time lost on the water due to thunderstorms.";

  const GREETING =
    "Hey there! ⚓ Welcome to Texas Forever Charters. I can help with rates, availability, " +
    "or anything about a day on Lake Travis. What would you like to know?";

  let chatHistory = [];
  let isWaiting = false;

  // ── Styles ──────────────────────────────────────────────────
  const STYLES = `
    #tfc-chat-btn {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 9998;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: #C8102E;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 24px rgba(200,16,46,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
      font-size: 24px;
      color: #fff;
    }
    #tfc-chat-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 32px rgba(200,16,46,0.7);
    }
    #tfc-chat-btn.tfc-active {
      background: #1B2A6B;
      box-shadow: 0 4px 24px rgba(27,42,107,0.6);
    }
    #tfc-chat-window {
      position: fixed;
      bottom: 102px;
      right: 28px;
      z-index: 9999;
      width: 370px;
      height: 530px;
      background: #111B47;
      border-radius: 8px 8px 4px 4px;
      box-shadow: 0 16px 56px rgba(0,0,0,0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: translateY(12px) scale(0.97);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    #tfc-chat-window.tfc-open {
      transform: translateY(0) scale(1);
      opacity: 1;
      pointer-events: all;
    }
    #tfc-chat-header {
      background: #1B2A6B;
      border-top: 3px solid #C8102E;
      padding: 13px 16px 11px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    #tfc-chat-header-info {
      display: flex;
      flex-direction: column;
    }
    #tfc-chat-title {
      font-family: 'Bebas Neue', 'Impact', sans-serif;
      font-size: 17px;
      letter-spacing: 2px;
      color: #fff;
      line-height: 1;
    }
    #tfc-chat-subtitle {
      font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: rgba(200,208,232,0.65);
      margin-top: 3px;
    }
    #tfc-chat-close {
      background: none;
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.18s, border-color 0.18s;
      flex-shrink: 0;
      line-height: 1;
    }
    #tfc-chat-close:hover {
      background: #C8102E;
      border-color: #C8102E;
    }
    #tfc-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px 8px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      scroll-behavior: smooth;
    }
    #tfc-chat-messages::-webkit-scrollbar { width: 3px; }
    #tfc-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #tfc-chat-messages::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.12);
      border-radius: 2px;
    }
    .tfc-msg {
      max-width: 86%;
      padding: 9px 13px;
      border-radius: 4px;
      font-family: 'Barlow', 'Arial', sans-serif;
      font-size: 13.5px;
      line-height: 1.55;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .tfc-msg-bot {
      background: rgba(255,255,255,0.07);
      color: #C8D0E8;
      align-self: flex-start;
      border-left: 3px solid #C8102E;
    }
    .tfc-msg-user {
      background: #C8102E;
      color: #fff;
      align-self: flex-end;
    }
    .tfc-msg-typing {
      background: rgba(255,255,255,0.05);
      color: rgba(200,208,232,0.55);
      align-self: flex-start;
      border-left: 3px solid rgba(200,16,46,0.4);
      font-style: italic;
      font-family: 'Barlow', 'Arial', sans-serif;
      font-size: 13px;
      padding: 9px 13px;
      border-radius: 4px;
    }
    #tfc-chat-form {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(0,0,0,0.28);
      border-top: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    #tfc-chat-input {
      flex: 1;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
      color: #fff;
      font-family: 'Barlow', 'Arial', sans-serif;
      font-size: 13.5px;
      padding: 9px 11px;
      outline: none;
      resize: none;
      min-height: 38px;
      max-height: 88px;
      overflow-y: auto;
      line-height: 1.45;
      transition: border-color 0.18s;
    }
    #tfc-chat-input::placeholder { color: rgba(255,255,255,0.3); }
    #tfc-chat-input:focus { border-color: rgba(200,16,46,0.5); }
    #tfc-send-btn {
      background: #C8102E;
      border: none;
      color: #fff;
      width: 38px;
      height: 38px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 17px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.18s;
    }
    #tfc-send-btn:hover:not(:disabled) { background: #A00D25; }
    #tfc-send-btn:disabled { opacity: 0.38; cursor: not-allowed; }
    #tfc-chat-footer {
      text-align: center;
      padding: 5px 12px 7px;
      font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif;
      font-size: 10px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(200,208,232,0.25);
      background: rgba(0,0,0,0.18);
      flex-shrink: 0;
    }
    @media (max-width: 480px) {
      #tfc-chat-window {
        width: calc(100vw - 24px);
        right: 12px;
        bottom: 92px;
        height: calc(100svh - 110px);
        max-height: 530px;
      }
      #tfc-chat-btn { right: 16px; bottom: 18px; }
    }
  `;

  // ── Build Widget ─────────────────────────────────────────────
  function buildWidget() {
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    // Floating button
    const btn = document.createElement('button');
    btn.id = 'tfc-chat-btn';
    btn.setAttribute('aria-label', 'Chat with us');
    btn.textContent = '⚓';
    btn.addEventListener('click', toggleChat);
    document.body.appendChild(btn);

    // Chat window
    const win = document.createElement('div');
    win.id = 'tfc-chat-window';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-label', 'Texas Forever Charters live chat');
    win.innerHTML =
      '<div id="tfc-chat-header">' +
        '<div id="tfc-chat-header-info">' +
          '<span id="tfc-chat-title">Texas Forever Charters</span>' +
          '<span id="tfc-chat-subtitle">AI Receptionist &middot; Lake Travis</span>' +
        '</div>' +
        '<button id="tfc-chat-close" aria-label="Close chat">&#10005;</button>' +
      '</div>' +
      '<div id="tfc-chat-messages"></div>' +
      '<div id="tfc-chat-form">' +
        '<textarea id="tfc-chat-input" rows="1" placeholder="Ask about rates, boats, availability..."></textarea>' +
        '<button id="tfc-send-btn" aria-label="Send">&#10148;</button>' +
      '</div>' +
      '<div id="tfc-chat-footer">Powered by Claude AI &middot; Texas Forever Charters</div>';
    document.body.appendChild(win);

    // Events
    document.getElementById('tfc-chat-close').addEventListener('click', closeChat);
    document.getElementById('tfc-send-btn').addEventListener('click', handleSend);

    const input = document.getElementById('tfc-chat-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 88) + 'px';
    });

    // ESC closes
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeChat();
    });

    // Show greeting
    addMessage(GREETING, 'bot');
  }

  // ── Open / Close / Toggle ────────────────────────────────────
  function toggleChat() {
    var win = document.getElementById('tfc-chat-window');
    if (win.classList.contains('tfc-open')) {
      closeChat();
    } else {
      openWidget();
    }
  }

  function openWidget(prefillText) {
    var win = document.getElementById('tfc-chat-window');
    var btn = document.getElementById('tfc-chat-btn');
    win.classList.add('tfc-open');
    btn.classList.add('tfc-active');

    if (prefillText) {
      var input = document.getElementById('tfc-chat-input');
      input.value = prefillText;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 88) + 'px';
      setTimeout(handleSend, 320);
    } else {
      setTimeout(function () {
        var el = document.getElementById('tfc-chat-input');
        if (el) el.focus();
      }, 80);
    }
  }

  function closeChat() {
    var win = document.getElementById('tfc-chat-window');
    var btn = document.getElementById('tfc-chat-btn');
    if (win) win.classList.remove('tfc-open');
    if (btn) btn.classList.remove('tfc-active');
  }

  // ── Messages ─────────────────────────────────────────────────
  function addMessage(text, role) {
    var container = document.getElementById('tfc-chat-messages');
    var el = document.createElement('div');
    el.className = 'tfc-msg tfc-msg-' + role;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function showTyping() {
    var container = document.getElementById('tfc-chat-messages');
    var el = document.createElement('div');
    el.id = 'tfc-typing';
    el.className = 'tfc-msg-typing';
    el.textContent = 'Typing…';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById('tfc-typing');
    if (el) el.remove();
  }

  // ── Send ─────────────────────────────────────────────────────
  function handleSend() {
    if (isWaiting) return;
    var input = document.getElementById('tfc-chat-input');
    var sendBtn = document.getElementById('tfc-send-btn');
    var text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    addMessage(text, 'user');
    chatHistory.push({ role: 'user', content: text });

    isWaiting = true;
    sendBtn.disabled = true;
    showTyping();

    callClaude(chatHistory).then(function (reply) {
      hideTyping();
      addMessage(reply, 'bot');
      chatHistory.push({ role: 'assistant', content: reply });
    }).catch(function () {
      hideTyping();
      addMessage(
        "Sorry, I'm having a connection issue. Please call us at (737) 368-1669 or visit texasforevercharters.com to book!",
        'bot'
      );
    }).finally(function () {
      isWaiting = false;
      sendBtn.disabled = false;
      var inp = document.getElementById('tfc-chat-input');
      if (inp) inp.focus();
    });
  }

  // ── API (proxied through /api/chat) ─────────────────────────
  function callClaude(history) {
    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: history
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('API ' + res.status);
      return res.json();
    }).then(function (data) {
      return data.content[0].text;
    });
  }

  // ── Public API ───────────────────────────────────────────────
  window.openChatWithExperience = function (experienceName) {
    openWidget("Hi! I’m interested in the " + experienceName + ".");
  };

  window.tfcOpenChat = openWidget;
  window.tfcCloseChat = closeChat;

  // ── Init ─────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }

}());
