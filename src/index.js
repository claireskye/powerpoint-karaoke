export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
    this.score = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // 1. Host connecting to the lobby via WebSocket
    if (url.pathname.includes('/ws/host')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      server.accept();
      this.sessions.push(server);
      
      server.addEventListener('close', () => {
        this.sessions = this.sessions.filter(s => s !== server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Mobile Voter connecting via WebSocket (Dramatically improves stability/latency over HTTP POST)
    if (url.pathname.includes('/ws/voter')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      server.accept();
      
      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.score += data.points;
          
          // Broadcast the Emoji reaction directly to the host screens
          const message = JSON.stringify({
            type: 'reaction',
            text: data.text, // Strict Emoji
            points: data.points
          });
          
          this.sessions.forEach(session => {
            try { session.send(message); } catch (e) {}
          });
        } catch(e) {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }
    
    // Legacy /vote POST route kept for fallback API support
    if (url.pathname.includes('/vote') && request.method === 'POST') {
      try {
        const data = await request.json();
        this.score += data.points;
        const message = JSON.stringify({ type: 'reaction', text: data.text, points: data.points });
        
        this.sessions.forEach(session => {
          try { session.send(message); } catch (e) {}
        });

        return new Response(JSON.stringify({ success: true }));
      } catch (err) {
        return new Response('Bad Request', { status: 400 });
      }
    }

    // 3. Fetch final score
    if (url.pathname.includes('/score') && request.method === 'GET') {
      return new Response(JSON.stringify({ score: this.score }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- DURABLE OBJECT ROUTING ---
    const lobbyMatch = path.match(/(?:\/api\/ws\/host|\/api\/ws\/voter|\/api\/vote|\/api\/score)\/([^\/]+)/);
    if (lobbyMatch) {
      const lobbyId = lobbyMatch[1];
      const id = env.LOBBY_DO.idFromName(lobbyId);
      const stub = env.LOBBY_DO.get(id);
      return stub.fetch(request);
    }

    // --- MOBILE VOTER INTERFACE ---
    if (path.startsWith('/vote/')) {
      const lobbyId = path.split('/vote/')[1];
      return new Response(htmlMobile.replace(/{{LOBBY_ID}}/g, lobbyId), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // --- BACKEND API ROUTES ---
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("presentation");
        const displayName = formData.get("name") || "Untitled";
        const authorName = formData.get("author") || "Anonymous";
        const isAnonymous = formData.get("isAnonymous") === "true";
        const playerId = isAnonymous ? null : formData.get("playerId"); 
        const optInPool = formData.get("optInPool") === "true" ? 1 : 0;

        if (!file || !(file instanceof File)) {
          return new Response("Missing file", { status: 400 });
        }

        const id = crypto.randomUUID();
        const r2Key = `presentations/${id}.pdf`;
        const buffer = await file.arrayBuffer();

        await env['karaoke-slides'].put(r2Key, buffer, {
          httpMetadata: { contentType: "application/pdf" }
        });

        await env['karaoke-db'].prepare(
          `INSERT INTO presentations (id, display_name, r2_object_key, creator_player_id, is_pool_eligible, is_premade, author_name) 
           VALUES (?, ?, ?, ?, ?, 0, ?)`
        ).bind(id, displayName, r2Key, playerId, optInPool, authorName).run();

        return new Response(JSON.stringify({ success: true, id }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    if (path === "/api/list" && request.method === "GET") {
        const { results } = await env['karaoke-db'].prepare("SELECT id, display_name, author_name FROM presentations").all();
        return new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" }
        });
    }

    if (path.startsWith("/api/delete/") && request.method === "POST") {
      try {
        const providedKey = request.headers.get("X-Admin-Key");
        if (!env.ADMIN_SECRET || providedKey !== env.ADMIN_SECRET) {
            return new Response(JSON.stringify({ error: "Invalid Key" }), {
                status: 401, headers: { "Content-Type": "application/json" }
            });
        }
        const fileId = path.split("/api/delete/")[1];
        const r2Key = `presentations/${fileId}.pdf`;
        await env['karaoke-slides'].delete(r2Key);
        await env['karaoke-db'].prepare("DELETE FROM presentations WHERE id = ?").bind(fileId).run();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    if (path === "/api/assign" && request.method === "GET") {
      const targetPlayerId = url.searchParams.get("playerId");
      const skipFiltering = url.searchParams.get("skipFiltering") === "true";
      const customPoolIds = url.searchParams.get("customPool"); 

      let query;
      let params = [];

      if (customPoolIds) {
        const ids = customPoolIds.split(',');
        const placeholders = ids.map(() => '?').join(',');
        query = `SELECT * FROM presentations WHERE id IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`;
        params = ids;
      } 
      else if (skipFiltering || !targetPlayerId) {
        query = `SELECT * FROM presentations ORDER BY RANDOM() LIMIT 1`;
      } 
      else {
        query = `SELECT * FROM presentations WHERE (is_premade = 1) OR (is_pool_eligible = 1 AND creator_player_id != ?) OR (creator_player_id != ? AND is_premade = 0) OR (creator_player_id IS NULL) ORDER BY RANDOM() LIMIT 1`;
        params = [targetPlayerId, targetPlayerId];
      }
      
      const { results } = await env['karaoke-db'].prepare(query).bind(...params).all();

      if (!results || results.length === 0) {
        return new Response(JSON.stringify({ error: "No matches." }), {
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify(results[0]), { headers: { "Content-Type": "application/json" } });
    }

    if (path.startsWith("/api/file/") && request.method === "GET") {
      const fileId = path.split("/api/file/")[1];
      const objectKey = `presentations/${fileId}.pdf`;
      const object = await env['karaoke-slides'].get(objectKey);
      if (!object) return new Response("File Not Found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(object.body, { headers });
    }

    // Host Front-end
    return new Response(htmlFrontend, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// --- MOBILE VOTER INTERFACE (MAXIMALIST AERO / 100VW 100VH) ---
const htmlMobile = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Live Vote</title>
    <style>
        * { box-sizing: border-box; touch-action: manipulation; }
        body {
            font-family: 'Trebuchet MS', 'Lucida Sans', Tahoma, sans-serif;
            margin: 0; padding: 0; text-align: center;
            background: linear-gradient(135deg, #00C6FF 0%, #0072FF 50%, #00C6FF 100%);
            background-size: 200% 200%; animation: aurora 10s ease infinite;
            height: 100vh; width: 100vw; overflow: hidden;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
        }
        .grid {
            display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
            gap: 15px; width: 100%; height: 100%; padding: 15px;
        }
        .btn {
            position: relative;
            background: linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.4) 49%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.6) 100%);
            border: 4px solid rgba(255,255,255,0.8); border-radius: 40px;
            font-size: 10vh; cursor: pointer;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3), inset 0 -5px 15px rgba(0,0,0,0.2), inset 0 5px 15px rgba(255,255,255,1);
            transition: all 0.1s; display: flex; align-items: center; justify-content: center;
            overflow: hidden;
        }
        .btn::after {
            content: ''; position: absolute; top: 0; left: 10%; width: 80%; height: 40%;
            background: linear-gradient(180deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 100%);
            border-radius: 50% / 100% 100% 0 0; pointer-events: none;
        }
        .btn:active {
            transform: scale(0.95) translateY(5px);
            background: linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.2) 100%);
            box-shadow: 0 4px 10px rgba(0,0,0,0.3), inset 0 5px 20px rgba(0,0,0,0.4);
            border-color: #00FFCC;
        }
        .feedback {
            position: fixed; top: 20px; z-index: 100;
            background: rgba(255,255,255,0.9); padding: 10px 30px; border-radius: 30px;
            font-weight: bold; font-size: 20px; color: #0072FF;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3); border: 2px solid #fff;
            opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none;
            transform: translateY(-20px);
        }
        .feedback.show { opacity: 1; transform: translateY(0); }
        .ws-status {
            position: fixed; bottom: 5px; left: 5px; z-index: 200;
            font-size: 12px; color: rgba(255,255,255,0.7); font-weight: bold;
        }
        @keyframes aurora { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
    </style>
</head>
<body>
    <div id="feedback" class="feedback">Sent!</div>
    <div class="grid">
        <button class="btn" onclick="vote('👏', 1)">👏</button>
        <button class="btn" onclick="vote('😂', 2)">😂</button>
        <button class="btn" onclick="vote('💡', 5)">💡</button>
        <button class="btn" onclick="vote('👎', -1)">👎</button>
    </div>
    <div class="ws-status" id="ws-status">🟡 Connecting...</div>
    <script>
        let ws;
        const lobbyId = '{{LOBBY_ID}}';
        
        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}/api/ws/voter/\${lobbyId}\`);
            
            ws.onopen = () => { document.getElementById('ws-status').innerText = '🟢 Live'; };
            ws.onclose = () => { 
                document.getElementById('ws-status').innerText = '🔴 Reconnecting...'; 
                setTimeout(connect, 1000); 
            };
            ws.onerror = () => { ws.close(); };
        }
        connect();

        function vote(text, points) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ text, points }));
            } else {
                // Fallback to fetch if WS drops momentarily
                fetch('/api/vote/' + lobbyId, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, points })
                }).catch(()=>{});
            }
            const fb = document.getElementById('feedback');
            fb.classList.add('show');
            setTimeout(() => fb.classList.remove('show'), 600);
            
            if ("vibrate" in navigator) navigator.vibrate(50);
        }
    </script>
</body>
</html>
`;

// --- HOST INTERFACE (MAXIMALIST AERO / FRUTIGER WII STYLED) ---
const htmlFrontend = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PowerPoint Karaoke</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>

    <style>
        body {
            margin: 0; padding: 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #222; min-height: calc(100vh - 40px);
            display: flex; justify-content: center; align-items: center;
            background: linear-gradient(135deg, #71B280 0%, #134E5E 100%); /* Lush natural aero colors */
            background-attachment: fixed; overflow-x: hidden;
        }

        #toast-container { position: fixed; top: 20px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 15px; }
        .toast {
            background: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(240,250,255,0.85));
            border: 2px solid #fff; padding: 20px 30px;
            border-radius: 15px; box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            font-weight: bold; font-size: 18px; animation: slideIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            backdrop-filter: blur(10px);
        }

        .dashboard-grid { display: grid; grid-template-columns: 400px 1fr; gap: 30px; width: 100%; max-width: 1200px; z-index: 10; }

        .glass-panel {
            background: linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.2) 100%);
            border: 3px solid rgba(255,255,255,0.8); border-radius: 30px; padding: 30px;
            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2), inset 0 2px 15px rgba(255, 255, 255, 1);
            backdrop-filter: blur(20px); display: flex; flex-direction: column; gap: 20px;
            position: relative; overflow: hidden;
        }
        .glass-panel::before {
            content: ''; position: absolute; top: 0; left: -50%; width: 200%; height: 200px;
            background: linear-gradient(180deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 100%);
            transform: rotate(-15deg); pointer-events: none;
        }

        .module {
            background: rgba(255, 255, 255, 0.7); border: 2px solid #fff; border-radius: 20px; padding: 20px;
            box-shadow: inset 0 5px 10px rgba(255,255,255,0.8), 0 5px 15px rgba(0,0,0,0.1);
        }

        h2 { margin: 0 0 10px 0; color: #134E5E; text-transform: uppercase; font-size: 22px; letter-spacing: 2px; text-shadow: 0 2px 4px #fff; }

        .btn {
            position: relative; background: linear-gradient(180deg, #ffffff 0%, #e0f2fe 100%);
            border: 3px solid #fff; border-radius: 50px; padding: 15px 25px;
            color: #333; font-size: 20px; font-weight: bold; cursor: pointer;
            box-shadow: 0 6px 15px rgba(0,0,0,0.15), inset 0 -3px 5px rgba(0,0,0,0.1), inset 0 5px 10px rgba(255,255,255,1);
            transition: all 0.15s; text-transform: uppercase; text-align: center;
            display: inline-flex; justify-content: center; align-items: center; gap: 10px; overflow: hidden;
        }
        .btn::after {
            content: ''; position: absolute; top: 2px; left: 5%; width: 90%; height: 40%;
            background: linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 100%);
            border-radius: 50px 50px 0 0; pointer-events: none;
        }
        .btn:hover { background: linear-gradient(180deg, #ffffff 0%, #bae6fd 100%); transform: scale(1.05); box-shadow: 0 8px 20px rgba(0,168,255,0.3); border-color: #7dd3fc; }
        .btn:active { transform: scale(0.95); box-shadow: inset 0 5px 10px rgba(0,0,0,0.2); }
        .btn-primary { background: linear-gradient(180deg, #7dd3fc 0%, #38bdf8 100%); color: #0f172a; border-color: #e0f2fe; animation: pulseGlow 2s infinite; }
        .btn-icon { width: 60px; height: 60px; padding: 0; font-size: 28px; border-radius: 50%; }

        input[type="text"] {
            width: 100%; box-sizing: border-box; padding: 15px; border: 2px solid #ccc;
            border-radius: 15px; margin-top: 10px; font-size: 18px; font-family: inherit;
            box-shadow: inset 0 3px 6px rgba(0,0,0,0.1); background: rgba(255,255,255,0.9);
        }
        input[type="text"]:focus { border-color: #38bdf8; outline: none; box-shadow: 0 0 10px rgba(56,189,248,0.5), inset 0 3px 6px rgba(0,0,0,0.1); }
        
        .row-options { display: flex; align-items: center; gap: 15px; margin-top: 15px; flex-wrap: wrap; }
        
        /* Icon Toggles replacing checkboxes */
        label.icon-toggle { display: inline-flex; cursor: pointer; }
        label.icon-toggle input:checked ~ .btn { background: linear-gradient(180deg, #86efac 0%, #4ade80 100%); border-color: #dcfce7; box-shadow: 0 0 15px rgba(74,222,128,0.6); }

        .list-container { max-height: 250px; overflow-y: auto; background: rgba(255,255,255,0.8); border: 2px solid #fff; border-radius: 15px; padding: 10px; margin-top: 15px; box-shadow: inset 0 5px 10px rgba(0,0,0,0.05); }
        .list-item { display: flex; align-items: center; justify-content: space-between; font-size: 16px; padding: 12px; border-bottom: 2px solid rgba(0,0,0,0.05); }
        .delete-btn { color: #ef4444; cursor: pointer; font-size: 24px; background: none; border: none; transition: transform 0.2s; }
        .delete-btn:hover { transform: scale(1.3); }

        .spinner {
            border: 4px solid rgba(0,0,0,0.1); width: 20px; height: 20px; border-radius: 50%;
            border-left-color: #38bdf8; animation: spin 1s linear infinite; display: inline-block;
        }

        #fullscreen-stage {
            display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: #000; z-index: 9999; flex-direction: column; align-items: center; justify-content: center;
        }

        #lobby-overlay {
            display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 60px;
            color: #fff; height: 100%; width: 100%; background: radial-gradient(circle at center, #1e293b, #020617);
        }
        .qr-box { background: #fff; padding: 25px; border-radius: 30px; box-shadow: 0 0 50px rgba(56,189,248,0.5); }
        .qr-box img { width: 300px; height: 300px; }
        .lobby-text { text-align: left; }
        .lobby-title { font-size: 50px; font-weight: bold; margin-bottom: 10px; text-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .lobby-sub { font-size: 24px; color: #94a3b8; margin-bottom: 30px; }
        .start-action { font-size: 24px; color: #38bdf8; border: 3px solid #38bdf8; padding: 15px 30px; border-radius: 50px; display: inline-block; animation: pulseGlow 2s infinite; text-transform: uppercase; font-weight: bold; }

        #slide-container { display: none; position: relative; width: 100vw; height: 100vh; align-items: center; justify-content: center; overflow: hidden; background: #000; }
        #pdf-canvas { max-width: 100%; max-height: 100%; transition: transform 0.1s ease; }

        .controls {
            position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%);
            background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(240,245,255,0.8));
            padding: 15px 30px; border-radius: 50px; border: 3px solid #fff;
            display: flex; gap: 20px; box-shadow: 0 15px 40px rgba(0,0,0,0.6), inset 0 5px 10px rgba(255,255,255,1);
            opacity: 1; transition: opacity 0.5s ease; z-index: 10000; align-items: center; backdrop-filter: blur(10px);
        }
        .controls.fade-out { opacity: 0; pointer-events: none; }

        .floating-reaction {
            position: absolute; bottom: 10%; font-size: 15vh; font-weight: bold;
            filter: drop-shadow(0 10px 10px rgba(0,0,0,0.5));
            animation: floatUp 2s ease-out forwards; pointer-events: none; z-index: 9000;
        }

        #final-score-screen {
            display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            background: radial-gradient(circle, rgba(15,23,42,0.95), rgba(0,0,0,1)); z-index: 10001; flex-direction: column; align-items: center; justify-content: center; color: #fff;
        }
        .score-number { font-size: 180px; font-weight: bold; color: #38bdf8; margin: 20px 0; text-shadow: 0 0 50px rgba(56,189,248,0.8); }

        /* Goofy Transition Animations */
        .anim-basic-fade { animation: fadeFX 0.3s; }
        .anim-spin { animation: spinFX 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .anim-bounce { animation: bounceFX 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .anim-flip { animation: flipFX 0.6s ease-out; }
        .anim-zoom { animation: zoomFX 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .anim-slide-up { animation: slideUpFX 0.6s ease-out; }
        .anim-barrel-roll { animation: barrelRollFX 0.8s ease-out; }
        .anim-wobble { animation: wobbleFX 0.6s ease-out; }
        .anim-swing { animation: swingFX 0.8s ease-out; }

        @keyframes slideIn { from { transform: translateX(100%) scale(0.8); opacity: 0; } to { transform: translateX(0) scale(1); opacity: 1; } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        @keyframes fadeFX { 0% { opacity: 0.1; } 100% { opacity: 1; } }
        @keyframes spinFX { 0% { transform: rotate(-360deg) scale(0.01); opacity: 0; } 100% { transform: rotate(0deg) scale(1); opacity: 1; } }
        @keyframes bounceFX { 0% { transform: translateY(-500px); opacity: 0; } 50% { transform: translateY(50px); opacity: 1; } 100% { transform: translateY(0); } }
        @keyframes flipFX { 0% { transform: perspective(400px) rotateY(90deg); opacity: 0; } 100% { transform: perspective(400px) rotateY(0); opacity: 1; } }
        @keyframes zoomFX { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes slideUpFX { 0% { transform: translateY(100vh); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        @keyframes barrelRollFX { 0% { transform: rotate(720deg) scale(0.1); opacity: 0; } 100% { transform: rotate(0deg) scale(1); opacity: 1; } }
        @keyframes wobbleFX { 0% { transform: translateX(-50px) rotate(-5deg); opacity: 0; } 50% { transform: translateX(50px) rotate(5deg); opacity: 0.5; } 100% { transform: translateX(0) rotate(0); opacity: 1; } }
        @keyframes swingFX { 0% { transform: rotate3d(0, 0, 1, 90deg); transform-origin: top center; opacity: 0; } 100% { transform: rotate3d(0, 0, 1, 0deg); transform-origin: top center; opacity: 1; } }

        @keyframes floatUp { 0% { transform: translateY(0) scale(0.5); opacity: 0; } 20% { opacity: 1; scale: 1.2;} 100% { transform: translateY(-600px) scale(1.5) rotate(20deg); opacity: 0; } }
        @keyframes pulseGlow { 0% { box-shadow: 0 0 0 0 rgba(56,189,248,0.7); } 70% { box-shadow: 0 0 0 20px rgba(56,189,248,0); } 100% { box-shadow: 0 0 0 0 rgba(56,189,248,0); } }
    </style>
</head>
<body>

    <div id="toast-container"></div>

    <div class="dashboard-grid" id="main-dashboard">
        <div class="glass-panel">
            <h2>Upload Deck</h2>
            <div class="module">
                <div style="display: flex; gap: 10px;">
                    <label class="btn btn-icon" title="Select PDF File" style="flex-shrink:0;">
                        📁<input type="file" id="pdf-file" accept=".pdf" style="display:none;" onchange="document.getElementById('file-label').innerText = this.files[0]?.name || 'No file chosen';" />
                    </label>
                    <div id="file-label" style="flex-grow:1; border: 2px dashed #ccc; border-radius: 15px; padding: 15px; font-size: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; align-content: center; background: rgba(255,255,255,0.5);">Awaiting File...</div>
                </div>
                
                <input type="text" id="deck-name" placeholder="Title of Deck" />
                <input type="text" id="deck-author" placeholder="Author Name" />
                
                <div class="row-options">
                    <label class="icon-toggle" title="Add to Public Pool">
                        <input type="checkbox" id="opt-in-pool" checked style="display:none;">
                        <div class="btn btn-icon">🌍</div>
                    </label>
                    <label class="icon-toggle" title="Upload Anonymously">
                        <input type="checkbox" id="upload-anon" style="display:none;">
                        <div class="btn btn-icon">🥷</div>
                    </label>
                    <button class="btn" style="flex-grow: 1;" id="upload-btn" onclick="uploadDeck()" title="Upload File">
                        📤 UPLOAD <div id="upload-spinner" class="spinner" style="display:none;"></div>
                    </button>
                </div>
            </div>
        </div>

        <div class="glass-panel">
            <div class="module">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <h2>Available Decks</h2>
                    <div style="display:flex; gap: 10px;">
                        <button class="btn btn-icon" style="width:45px; height:45px; font-size:18px;" onclick="fetchList()" title="Refresh List">🔄</button>
                        <label class="icon-toggle" title="Select All">
                            <input type="checkbox" id="select-all-cb" style="display:none;" onchange="toggleSelectAll()">
                            <div class="btn btn-icon" style="width:45px; height:45px; font-size:18px;">☑️</div>
                        </label>
                    </div>
                </div>
                
                <div class="list-container" id="list-container">
                    <div style="color: #666; font-size: 16px; text-align:center; padding: 20px;">Loading decks...</div>
                </div>
            </div>

            <div class="module" style="text-align: center;">
                <div class="row-options" style="justify-content: center; margin-bottom: 20px;">
                    <label class="icon-toggle" title="Skip Filtering">
                        <input type="checkbox" id="test-override" style="display:none;">
                        <div class="btn btn-icon">🚦</div>
                    </label>
                    <button class="btn btn-primary" style="font-size: 26px; padding: 20px 40px;" onclick="initLobby()" title="Start Presentation">🚀 START KARAOKE</button>
                </div>
            </div>
        </div>
    </div>

    <div id="fullscreen-stage">
        
        <div id="lobby-overlay">
            <div class="qr-box">
                <img id="qr-image" src="" alt="Scan to Vote">
            </div>
            <div class="lobby-text">
                <div class="lobby-title" id="lobby-title">Loading Lobby...</div>
                <div class="lobby-sub" id="lobby-author">Waiting for Presenter...</div>
                <div class="start-action">PRESS SPACE TO START</div>
            </div>
        </div>

        <div id="slide-container">
            <canvas id="pdf-canvas"></canvas>
            
            <div class="controls" id="controls-bar">
                <button class="btn btn-icon" title="Previous Slide" onclick="prevSlide()">⏪</button>
                <span id="page-indicator" style="font-weight:900; min-width:80px; text-align:center; font-size: 20px; color:#134E5E;">1 / ?</span>
                <button class="btn btn-icon" title="Next Slide" onclick="nextSlide()">⏩</button>
                <div style="border-left: 3px solid #ccc; height: 40px; margin: 0 10px;"></div>
                
                <label class="icon-toggle" title="Toggle Reduced Motion FX">
                    <input type="checkbox" id="reduced-motion-cb" style="display:none;">
                    <div class="btn btn-icon">🐢</div>
                </label>
                <label class="icon-toggle" title="Hide Live Reactions">
                    <input type="checkbox" id="hide-reactions-cb" style="display:none;">
                    <div class="btn btn-icon">🙈</div>
                </label>
                
                <button class="btn btn-icon" style="color: #ef4444; border-color: #fecaca;" title="Abort Session" onclick="exitShow()">🚪</button>
            </div>
        </div>

        <div id="final-score-screen">
            <div style="font-size: 40px; font-weight: bold; text-shadow: 0 4px 10px rgba(0,0,0,0.8);">PRESENTATION FINISHED</div>
            <div class="score-number" id="final-score-display">0</div>
            <div style="font-size: 24px; color: #94a3b8;">TOTAL POINTS</div>
            <button class="btn" style="margin-top: 50px; font-size: 24px;" onclick="exitShow()">BACK TO HOME 🏠</button>
        </div>
    </div>

    <script>
        if (!localStorage.getItem('karaoke_pid')) {
            localStorage.setItem('karaoke_pid', 'usr_' + Math.random().toString(36).substring(2, 9));
        }
        const playerId = localStorage.getItem('karaoke_pid');
        let pdfDoc = null, pageNum = 1, pageRendering = false, pageNumPending = null;
        let inShow = false, inLobby = false, controlsTimeout = null;
        let activeLobbyId = null, wsConnection = null;

        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');
        const floatingBar = document.getElementById('controls-bar');
        
        const transitions = ['anim-spin', 'anim-bounce', 'anim-flip', 'anim-zoom', 'anim-slide-up', 'anim-barrel-roll', 'anim-wobble', 'anim-swing'];

        function showToast(msg) {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.innerText = msg;
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
        }

        async function uploadDeck() {
            const fileInput = document.getElementById('pdf-file');
            if (!fileInput.files[0]) return showToast("⚠️ Requires File Data Input.");

            document.getElementById('upload-spinner').style.display = 'inline-block';
            document.getElementById('upload-btn').style.pointerEvents = 'none';

            const fd = new FormData();
            fd.append('presentation', fileInput.files[0]);
            fd.append('name', document.getElementById('deck-name').value);
            fd.append('author', document.getElementById('deck-author').value);
            fd.append('playerId', playerId);
            fd.append('optInPool', document.getElementById('opt-in-pool').checked);
            fd.append('isAnonymous', document.getElementById('upload-anon').checked); 

            try {
                const res = await fetch('/api/upload', { method: 'POST', body: fd });
                if (res.ok) {
                    showToast("✅ File uploaded successfully.");
                    document.getElementById('deck-name').value = '';
                    document.getElementById('deck-author').value = '';
                    document.getElementById('file-label').innerText = 'Awaiting File...';
                    fileInput.value = '';
                    fetchList();
                } else showToast("❌ Upload Error: " + await res.text());
            } catch(e) { showToast("❌ Upload failed."); }
            
            document.getElementById('upload-spinner').style.display = 'none';
            document.getElementById('upload-btn').style.pointerEvents = 'auto';
        }

        async function fetchList() {
            const container = document.getElementById('list-container');
            container.innerHTML = "<div style='padding:20px; font-size:16px; text-align:center;'>Loading...</div>";
            const res = await fetch('/api/list');
            const decks = await res.json();
            
            container.innerHTML = "";
            if(decks.length === 0) return container.innerHTML = "<div style='padding:20px; font-size:16px; text-align:center;'>No decks found.</div>";
            
            decks.forEach(deck => {
                const div = document.createElement('div');
                div.className = 'list-item';
                div.innerHTML = \`
                    <div style="display:flex; align-items:center; gap:15px; overflow: hidden;">
                        <input type="checkbox" class="pool-cb" value="\${deck.id}" style="transform: scale(1.5);">
                        <strong style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">\${deck.display_name}</strong> 
                        <span style="color:#888;">(\${deck.author_name || 'N/A'})</span>
                    </div>
                    <button class="delete-btn" onclick="deleteDeck('\${deck.id}')" title="Delete Deck">🗑️</button>
                \`;
                container.appendChild(div);
            });
            document.getElementById('select-all-cb').checked = false;
        }

        function toggleSelectAll() {
            const state = document.getElementById('select-all-cb').checked;
            document.querySelectorAll('.pool-cb').forEach(cb => cb.checked = state);
        }

        async function deleteDeck(id) {
            const key = prompt("Auth Required: Admin Key");
            if(!key) return;
            try {
                const res = await fetch(\`/api/delete/\${id}\`, { method: 'POST', headers: { "X-Admin-Key": key } });
                if (res.ok) { fetchList(); showToast("🗑️ Deck deleted."); }
                else if (res.status === 401) showToast("❌ Auth Denied.");
                else showToast("❌ Deletion Failed.");
            } catch(e) { showToast("❌ Network Interruption."); }
        }

        async function initLobby() {
            const testOverride = document.getElementById('test-override').checked;
            const customIds = Array.from(document.querySelectorAll('.pool-cb:checked')).map(cb => cb.value).join(',');

            let endpoint = \`/api/assign?playerId=\${playerId}\`;
            if (testOverride) endpoint += '&skipFiltering=true';
            if (customIds) endpoint += \`&customPool=\${customIds}\`;

            const res = await fetch(endpoint);
            const deck = await res.json();

            if (deck.error || !deck.id) return showToast("⚠️ " + (deck.error || "No valid deck found."));

            activeLobbyId = crypto.randomUUID();
            setupWebSocket(activeLobbyId);

            document.getElementById('main-dashboard').style.display = 'none';
            document.getElementById('fullscreen-stage').style.display = 'flex';
            document.getElementById('lobby-overlay').style.display = 'flex';
            document.getElementById('slide-container').style.display = 'none';
            document.getElementById('final-score-screen').style.display = 'none';
            
            try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch(e){}

            document.getElementById('lobby-title').innerText = deck.display_name || "UNTITLED DECK";
            document.getElementById('lobby-author').innerText = "Authored by: " + (deck.author_name || "Unknown Identity");
            
            const qrUrl = \`https://\${window.location.host}/vote/\${activeLobbyId}\`;
            document.getElementById('qr-image').src = \`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=\${encodeURIComponent(qrUrl)}&color=134E5E\`;

            const loadingTask = pdfjsLib.getDocument(\`/api/file/\${deck.id}\`);
            loadingTask.promise.then(pdf => {
                pdfDoc = pdf;
                pageNum = 1;
                inLobby = true;
                showToast("✅ Deck loaded successfully.");
            }).catch(err => showToast("❌ Error loading presentation."));
        }

        function setupWebSocket(lobbyId) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}/api/ws/host/\${lobbyId}\`;
            wsConnection = new WebSocket(wsUrl);
            
            wsConnection.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'reaction' && !document.getElementById('hide-reactions-cb').checked) {
                    spawnReaction(data.text);
                }
            };

            // Vital robust auto-reconnect feature to prevent disconnects
            wsConnection.onclose = () => {
                if (activeLobbyId === lobbyId && (inShow || inLobby)) {
                    setTimeout(() => setupWebSocket(lobbyId), 1500);
                }
            };
        }

        function spawnReaction(text) {
            const el = document.createElement('div');
            el.className = 'floating-reaction';
            el.innerText = text; // strictly emoji
            // Randomly position horizontally
            el.style.left = Math.floor(Math.random() * 80 + 10) + '%';
            document.getElementById('slide-container').appendChild(el);
            setTimeout(() => el.remove(), 2000);
        }

        function startSlides() {
            inLobby = false;
            inShow = true;
            document.getElementById('lobby-overlay').style.display = 'none';
            document.getElementById('slide-container').style.display = 'flex';
            trackMouse();
            renderPage(pageNum);
        }

        function renderPage(num) {
            pageRendering = true;
            pdfDoc.getPage(num).then(page => {
                const container = document.getElementById('slide-container');
                const viewport = page.getViewport({ scale: 1 });
                const scale = Math.min((container.clientWidth) / viewport.width, (container.clientHeight) / viewport.height);
                const scaledViewport = page.getViewport({ scale: scale });

                canvas.height = scaledViewport.height;
                canvas.width = scaledViewport.width;

                const renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport });
                renderTask.promise.then(() => {
                    pageRendering = false;
                    document.getElementById('page-indicator').innerText = \`\${pageNum} / \${pdfDoc.numPages}\`;
                    if (pageNumPending !== null) { renderPage(pageNumPending); pageNumPending = null; }
                });
            });
            applyFX();
        }

        function applyFX() {
            canvas.classList.remove('anim-basic-fade', ...transitions);
            void canvas.offsetWidth; 
            if (document.getElementById('reduced-motion-cb').checked) {
                canvas.classList.add('anim-basic-fade');
            } else {
                const randomFX = transitions[Math.floor(Math.random() * transitions.length)];
                canvas.classList.add(randomFX);
            }
        }

        function queueRender(num) {
            if (pageRendering) pageNumPending = num;
            else renderPage(num);
        }

        function prevSlide() {
            if (pageNum <= 1) return;
            pageNum--; queueRender(pageNum);
        }

        function nextSlide() {
            if (pageNum >= pdfDoc.numPages) {
                finishPresentation();
                return;
            }
            pageNum++; queueRender(pageNum);
        }

        async function finishPresentation() {
            inShow = false;
            document.getElementById('slide-container').style.display = 'none';
            document.getElementById('final-score-screen').style.display = 'flex';
            
            try {
                const res = await fetch(\`/api/score/\${activeLobbyId}\`);
                const data = await res.json();
                animateScore(data.score);
            } catch(e) { showToast("⚠️ Couldn't load final score."); }
            
            if(wsConnection) {
                wsConnection.onclose = null; // prevent reconnect
                wsConnection.close();
            }
        }

        function animateScore(target) {
            let current = 0;
            const el = document.getElementById('final-score-display');
            const inc = Math.max(1, Math.floor(target / 50));
            const timer = setInterval(() => {
                current += inc;
                if (current >= target) {
                    current = target;
                    clearInterval(timer);
                }
                el.innerText = current;
            }, 40);
        }

        window.addEventListener('keydown', (e) => {
            if (inLobby && e.key === ' ') { e.preventDefault(); startSlides(); }
            if (!inShow) return;
            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); nextSlide(); }
            else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); prevSlide(); }
            else if (e.key === 'Escape') { e.preventDefault(); exitShow(); }
        });

        function trackMouse() {
            floatingBar.classList.remove('fade-out');
            clearTimeout(controlsTimeout);
            controlsTimeout = setTimeout(() => { if (inShow) floatingBar.classList.add('fade-out'); }, 3000);
        }

        document.getElementById('slide-container').addEventListener('mousemove', trackMouse);

        function exitShow() {
            inShow = false; inLobby = false; activeLobbyId = null;
            if(wsConnection) { wsConnection.onclose = null; wsConnection.close(); }
            clearTimeout(controlsTimeout);
            document.getElementById('fullscreen-stage').style.display = 'none';
            document.getElementById('main-dashboard').style.display = 'grid';
            if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
            pdfDoc = null;
        }

        window.onload = fetchList;
    </script>
</body>
</html>
`