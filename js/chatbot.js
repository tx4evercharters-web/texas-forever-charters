/* ============================================================
   TEXAS FOREVER CHARTERS — AI Chat Widget
   Powered by Claude (claude-sonnet-4-6)
   API calls proxied through /api/chat (Vercel serverless)
   ============================================================ */
(function () {
  'use strict';

  const MODEL = 'claude-sonnet-4-6';

  const SYSTEM_PROMPT =
    "You are the receptionist for Texas Forever Charters on Lake Travis, Austin TX. " +
    "Your job is to have a real conversation — not recite information. " +
    "\n\n" +
    "HOW TO BEHAVE:\n" +
    "- Respond like a warm, friendly human receptionist, not a brochure.\n" +
    "- Keep every response to 2-3 sentences maximum.\n" +
    "- Never dump a list of facts unprompted. Only share a detail when the customer asks for it.\n" +
    "- When someone says they are interested in an experience, acknowledge it warmly and ask ONE simple open-ended question to learn more about them — like what date they are thinking, how many people, or what the occasion is.\n" +
    "- Always end your response with a question or a warm invitation to keep the conversation going.\n" +
    "- When the customer seems ready to book or needs specifics, invite them to text (737) 368-1669 or email tx4evercharters@gmail.com.\n" +
    "- Never start a response by listing prices, policies, or features unless asked directly.\n" +
    "\n\n" +
    "REFERENCE — only use this when the customer asks:\n" +
    "\n" +
    "LOCATION & BOOKING: Pickup at Volente Beach Water Park and Resort on Lake Travis. Captains are DJ and Dane. Text (737) 368-1669 or email tx4evercharters@gmail.com to book. " +
    "\n\n" +
    "THE BOATS: 40ft Carver Aft Cabin yacht, up to 20 guests, $200-350/hr, full cabin below deck with salon, kitchen, bedroom, 2 restrooms. 24ft Bentley Navigator pontoon, up to 13 guests. Both BYOB friendly. " +
    "\n\n" +
    "EXPERIENCES & PRICING: Sunset cruises, private parties, corporate outings, boat tours, inner tube towing (pontoon). Boat tours are 2 hours at $150/hr, can be standalone or part of a charter. Mixed group tours available, call for pricing. Corporate outing pricing by phone only. We cannot guarantee a perfect sunset but we guarantee a great time. No fishing charters. " +
    "\n\n" +
    "GLASS: Allowed on the Carver yacht but must stay in the cabin. Not allowed on the pontoon at all. " +
    "\n\n" +
    "SAFETY: Life jackets provided for everyone. Kids under 13 must wear one at all times (Texas law). No smoking on either vessel — OK in the water or on a float. Vaping allowed on board. Guests swim at their own risk. " +
    "\n\n" +
    "FEES: Vomiting in the toilet is a $200 fee — use the lake or a trash bag. No feminine products in the toilets or $200 fee applies. You break it, you buy it. " +
    "\n\n" +
    "CANCELLATION & WEATHER: Paid in full one week in advance. Non-refundable within 2 weeks of charter date. Cancel 5+ days out: 50% refund. After that, non-refundable unless weather causes cancellation. Captains personally monitor weather and will never take guests out in dangerous conditions. Lake Travis often stays clear even when Austin is raining due to local wind patterns. Thunderstorms: full refund for any time lost on the water.";

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
    openWidget("Hi! I’m interested in the " + experienceName + " experience.");
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
