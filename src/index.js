export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- BACKEND API ROUTES ---

    // 1. Upload Custom Deck
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("presentation");
        const displayName = formData.get("name") || "Untitled Presentation";
        const authorName = formData.get("author") || "Anonymous";
        const isAnonymous = formData.get("isAnonymous") === "true";
        const playerId = isAnonymous ? null : formData.get("playerId"); 
        const optInPool = formData.get("optInPool") === "true" ? 1 : 0;

        if (!file || !(file instanceof File)) {
          return new Response("Missing presentation file", { status: 400 });
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

    // 2. Fetch all presentations
    if (path === "/api/list" && request.method === "GET") {
        const { results } = await env['karaoke-db'].prepare("SELECT id, display_name, author_name FROM presentations").all();
        return new Response(JSON.stringify(results || []), {
            headers: { "Content-Type": "application/json" }
        });
    }

    // 3. SECURE Delete Entry
    if (path.startsWith("/api/delete/") && request.method === "POST") {
      try {
        // SECURITY CHECK: Verify the provided Admin Key
        const providedKey = request.headers.get("X-Admin-Key");
        if (!env.ADMIN_SECRET || providedKey !== env.ADMIN_SECRET) {
            return new Response(JSON.stringify({ error: "Unauthorized: Invalid Admin Key" }), {
                status: 401, headers: { "Content-Type": "application/json" }
            });
        }

        const fileId = path.split("/api/delete/")[1];
        const r2Key = `presentations/${fileId}.pdf`;

        // Blast it from R2 Storage
        await env['karaoke-slides'].delete(r2Key);
        // Wipe it from D1 Database
        await env['karaoke-db'].prepare("DELETE FROM presentations WHERE id = ?").bind(fileId).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    // 4. Assign/Draw Presentation
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
        query = `
          SELECT * FROM presentations 
          WHERE (is_premade = 1) 
             OR (is_pool_eligible = 1 AND creator_player_id != ?)
             OR (creator_player_id != ? AND is_premade = 0)
             OR (creator_player_id IS NULL)
          ORDER BY RANDOM() LIMIT 1
        `;
        params = [targetPlayerId, targetPlayerId];
      }
      
      const { results } = await env['karaoke-db'].prepare(query).bind(...params).all();

      if (!results || results.length === 0) {
        return new Response(JSON.stringify({ error: "No decks match filters/pool configuration." }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify(results[0]), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 5. Serve File Content
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

    // Front-end delivery
    return new Response(htmlFrontend, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// --- FRUTIGER AERO WEB INTERFACE ---
const htmlFrontend = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🫧 PowerPoint Karaoke 🫧</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>

    <style>
        :root {
            --sky-blue: #a3d8f4;
            --eco-green: #a4e4b5;
            --glass-border: rgba(255, 255, 255, 0.8);
            --text-dark: #2a4365;
        }

        body {
            margin: 0; padding: 20px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: var(--text-dark);
            min-height: calc(100vh - 40px);
            display: flex; justify-content: center; align-items: center;
            background: 
                radial-gradient(circle at 15% 50%, rgba(164, 228, 181, 0.8), transparent 50%),
                radial-gradient(circle at 85% 30%, rgba(135, 206, 235, 0.8), transparent 50%),
                linear-gradient(135deg, #e0f7fa 0%, #f1f8e9 50%, #e1f5fe 100%);
            background-attachment: fixed;
        }

        .dashboard-grid {
            display: grid; grid-template-columns: 400px 1fr; gap: 25px;
            width: 100%; max-width: 1200px; z-index: 10;
        }

        .aero-window {
            background: linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.3) 100%);
            border: 2px solid var(--glass-border); border-top: 3px solid #ffffff;
            border-radius: 20px; padding: 25px;
            backdrop-filter: blur(16px);
            box-shadow: 0 15px 35px rgba(0, 100, 150, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.9);
            position: relative; display: flex; flex-direction: column; gap: 20px;
        }

        .section-card {
            background: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255, 255, 255, 0.8);
            border-radius: 12px; padding: 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.03);
        }

        h2, h3 { margin: 0; color: #1e3a5f; text-shadow: 0 2px 4px rgba(255,255,255,0.8); }

        .aero-btn {
            background: linear-gradient(to bottom, #87ceeb 0%, #4682b4 49%, #1e90ff 50%, #00bfff 100%);
            border: 1px solid rgba(0,0,0,0.2); border-radius: 25px; padding: 10px 20px;
            color: white; font-size: 15px; font-weight: bold; cursor: pointer;
            box-shadow: inset 0 2px 2px rgba(255,255,255,0.8), 0 4px 6px rgba(0,0,0,0.1);
            width: 100%; position: relative; overflow: hidden;
            text-shadow: 0 -1px 1px rgba(0,0,0,0.3);
        }
        .aero-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
        .btn-green { background: linear-gradient(to bottom, #98fb98 0%, #3cb371 49%, #2e8b57 50%, #3cb371 100%); }
        .btn-red { background: linear-gradient(to bottom, #ff9999 0%, #ff4d4d 49%, #cc0000 50%, #ff1a1a 100%); }

        input[type="text"], input[type="file"] {
            width: 100%; box-sizing: border-box; padding: 10px; border: 2px solid #b8cbd8;
            border-radius: 8px; margin-top: 5px; background: white;
        }
        
        .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; color: #334e68; }

        .pool-list {
            max-height: 200px; overflow-y: auto; background: rgba(255,255,255,0.7);
            border: 1px solid #ccc; border-radius: 8px; padding: 8px; margin-top: 10px;
        }
        .pool-item { 
            display: flex; align-items: center; justify-content: space-between; 
            font-size: 13px; margin-bottom: 6px; padding: 4px; border-bottom: 1px solid rgba(0,0,0,0.05);
        }
        .delete-icon {
            color: #cc0000; cursor: pointer; font-weight: bold; background: none; border: none; font-size: 14px;
        }
        .delete-icon:hover { transform: scale(1.2); }

        /* FULLSCREEN PRESENTATION STAGE */
        #fullscreen-stage {
            display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: #000; z-index: 9999; flex-direction: column; align-items: center; justify-content: center;
        }

        #intro-sequence {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            color: white; text-align: center; height: 100%; width: 100%;
            background: radial-gradient(circle, #1a2a6c, #112, #000);
        }
        #intro-title { font-size: 4rem; font-weight: bold; text-shadow: 0 4px 20px rgba(0,168,255,0.8); margin-bottom: 10px; }
        #intro-author { font-size: 2rem; color: #a3d8f4; margin-bottom: 40px; }
        #intro-countdown { font-size: 8rem; font-weight: bold; color: #ffeb3b; }

        #slide-container {
            display: none; position: relative; width: 100vw; height: 100vh;
            align-items: center; justify-content: center; overflow: hidden; background: #000;
        }
        #pdf-canvas { max-width: 100%; max-height: 100%; transition: transform 0.1s ease; }

        /* Floating Controller Bar with Soft Opacity Fading */
        .monitor-controls {
            position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%);
            background: rgba(255, 255, 255, 0.35); padding: 12px 25px; border-radius: 50px;
            display: flex; gap: 15px; backdrop-filter: blur(20px); border: 2px solid rgba(255,255,255,0.6);
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            opacity: 1; transition: opacity 0.5s ease; z-index: 10000;
        }
        .monitor-controls.hidden { opacity: 0; pointer-events: none; }

        /* WACKY ANIMATIONS COLLECTION */
        .anim-spin { animation: spin 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .anim-barrel { animation: barrel 0.7s cubic-bezier(0.455, 0.03, 0.515, 0.955); }
        .anim-hinge { animation: hinge 0.9s ease-in-out; }
        .anim-wobble { animation: wobble 0.6s ease-in-out; }
        .anim-zoom { animation: zoomBounce 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .anim-pageflip { animation: pageFlip 0.8s ease-in-out; transform-style: preserve-3d; }
        .anim-implode { animation: implode 0.7s ease-in; }

        /* Basic Fade for Reduced Motion mode */
        .anim-basic-fade { animation: basicFade 0.2s ease-in-out; }
        
        @keyframes spin { 0% { transform: rotate(-360deg) scale(0.1); opacity: 0; } 100% { transform: rotate(0deg) scale(1); opacity: 1; } }
        @keyframes barrel { 0% { transform: rotateX(90deg) rotateY(90deg); opacity: 0; } 100% { transform: rotateX(0) rotateY(0); opacity: 1; } }
        @keyframes hinge { 0% { transform: rotate(0); transform-origin: top left; } 30% { transform: rotate(60deg); } 70% { transform: rotate(-10deg); } 100% { transform: rotate(0); } }
        @keyframes wobble { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-15px) rotate(-3deg); } 40% { transform: translateX(12px) rotate(3deg); } 60% { transform: translateX(-8px) rotate(-1deg); } 80% { transform: translateX(4px) rotate(1deg); } }
        @keyframes zoomBounce { 0% { transform: scale(0.3); opacity: 0; } 70% { transform: scale(1.05); } 100% { transform: scale(1); opacity: 1; } }
        @keyframes pageFlip { 0% { transform: rotateY(-90deg); opacity: 0; } 100% { transform: rotateY(0deg); opacity: 1; } }
        @keyframes implode { 0% { transform: scale(1.8); filter: blur(10px); opacity: 0; } 100% { transform: scale(1); filter: blur(0); opacity: 1; } }
        @keyframes basicFade { 0% { opacity: 0.4; } 100% { opacity: 1; } }
    </style>
</head>
<body>

    <div class="dashboard-grid" id="main-dashboard">
        
        <div class="aero-window">
            <h2>🫧 Presentation Hub</h2>
            <div class="section-card">
                <h3>📥 Upload Custom Deck</h3>
                <input type="file" id="pdf-file" accept=".pdf" />
                <input type="text" id="deck-name" placeholder="Topic Label (e.g., Why Bananas Rule)" />
                <input type="text" id="deck-author" placeholder="Author/Creator Name" />
                
                <div class="checkbox-row">
                    <input type="checkbox" id="opt-in-pool" checked> <label>Allow into global game pool</label>
                </div>
                <div class="checkbox-row">
                    <input type="checkbox" id="upload-anon"> <label style="color:#0066cc;">Upload anonymously</label>
                </div>
                <button class="aero-btn" style="margin-top:15px;" onclick="uploadDeck()">Commit to Memory</button>
            </div>
        </div>

        <div class="aero-window">
            <div class="section-card">
                <h3>🎯 Curate Custom Pool</h3>
                <p style="font-size: 12px;">Tick entries to create a matching restricted custom draw pool. Unwanted files can be removed via the ❌ icon (Requires Admin Key).</p>
                <button class="aero-btn" style="padding: 6px; font-size: 12px; margin-bottom: 5px;" onclick="fetchPoolList()">🔄 Refresh Available Decks</button>
                <div class="pool-list" id="pool-checklist">
                    <div style="color: #666; font-size: 12px; text-align:center;">Click refresh to load decks...</div>
                </div>
            </div>

            <div class="section-card">
                <h3>🎮 Start Show</h3>
                <div class="checkbox-row" style="margin-bottom: 10px;">
                    <input type="checkbox" id="test-override"> <label style="color: #d32f2f; font-weight: bold;">⚠️ Disable anti-self draw (Testing)</label>
                </div>
                <button class="aero-btn btn-green" style="font-size: 18px; padding: 15px;" onclick="startPresentation()">DRAW & GO FULLSCREEN ⚡</button>
            </div>
        </div>
    </div>

    <div id="fullscreen-stage">
        
        <div id="intro-sequence">
            <div id="intro-title">Loading Topic...</div>
            <div id="intro-author">By: Unknown</div>
            <div id="intro-countdown"></div>
        </div>

        <div id="slide-container">
            <canvas id="pdf-canvas"></canvas>
            
            <div class="monitor-controls" id="floating-bar">
                <button class="aero-btn" style="width: auto;" onclick="prevSlide()">◀ Back</button>
                <span id="page-indicator" style="color:white; display:flex; align-items:center; font-weight:bold; min-width:60px; justify-content:center;">1 / ?</span>
                <button class="aero-btn" style="width: auto;" onclick="nextSlide()">Forward ▶</button>
                
                <div style="border-left: 1px solid rgba(255,255,255,0.4); margin: 0 5px;"></div>
                
                <label style="display:flex; align-items:center; gap:5px; color:white; font-size:12px; font-weight:bold; cursor:pointer;">
                    <input type="checkbox" id="reduced-motion-cb"> 🍃 Reduced FX
                </label>
                
                <button class="aero-btn btn-red" style="width: auto;" onclick="killPlayback()">✕ Exit</button>
            </div>
        </div>
    </div>

    <script>
        if (!localStorage.getItem('karaoke_player_id')) {
            localStorage.setItem('karaoke_player_id', 'user_' + Math.random().toString(36).substring(2, 11));
        }
        const playerId = localStorage.getItem('karaoke_player_id');

        let pdfDoc = null;
        let pageNum = 1;
        let pageRendering = false;
        let pageNumPending = null;
        let inPresentationMode = false;
        
        // Controls Auto-Hide Tracking variables
        let controlsTimeout = null;
        const floatingBar = document.getElementById('floating-bar');

        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');

        async function uploadDeck() {
            const fileInput = document.getElementById('pdf-file');
            if (!fileInput.files[0]) return alert("Please select a PDF file.");

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
                    alert("✨ Slide matrix integrated!");
                    document.getElementById('deck-name').value = '';
                    document.getElementById('deck-author').value = '';
                    fileInput.value = '';
                    fetchPoolList();
                } else alert("Error: " + await res.text());
            } catch(e) { alert("Upload failed."); }
        }

        async function fetchPoolList() {
            const listDiv = document.getElementById('pool-checklist');
            listDiv.innerHTML = "Loading...";
            const res = await fetch('/api/list');
            const decks = await res.json();
            
            listDiv.innerHTML = "";
            if(decks.length === 0) return listDiv.innerHTML = "No decks discovered.";
            
            decks.forEach(deck => {
                const div = document.createElement('div');
                div.className = 'pool-item';
                div.innerHTML = \`
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" class="pool-cb" value="\${deck.id}">
                        <strong>\${deck.display_name}</strong> <span style="opacity:0.7; font-size:11px;">(By: \${deck.author_name || 'Mystery'})</span>
                    </div>
                    <button class="delete-icon" onclick="deleteDeck('\${deck.id}')" title="Delete this entry">❌</button>
                \`;
                listDiv.appendChild(div);
            });
        }

        async function deleteDeck(id) {
            const adminKey = prompt("🔐 Enter the Admin Key to confirm deletion:");
            if(!adminKey) return; // User cancelled the prompt

            try {
                const res = await fetch(\`/api/delete/\${id}\`, { 
                    method: 'POST',
                    headers: { "X-Admin-Key": adminKey }
                });
                
                if (res.ok) {
                    fetchPoolList(); // Instantly update view
                } else if (res.status === 401) {
                    alert("❌ Incorrect Admin Key. Nice try!");
                } else {
                    alert("Failed deleting file record.");
                }
            } catch(e) { alert("Connection error."); }
        }

        async function startPresentation() {
            const testOverride = document.getElementById('test-override').checked;
            const checkboxes = document.querySelectorAll('.pool-cb:checked');
            const customIds = Array.from(checkboxes).map(cb => cb.value).join(',');

            let endpoint = \`/api/assign?playerId=\${playerId}\`;
            if (testOverride) endpoint += '&skipFiltering=true';
            if (customIds) endpoint += \`&customPool=\${customIds}\`;

            const res = await fetch(endpoint);
            const deck = await res.json();

            if (deck.error || !deck.id) return alert(deck.error || "No match discovered.");

            document.getElementById('main-dashboard').style.display = 'none';
            document.getElementById('fullscreen-stage').style.display = 'flex';
            
            try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch(e){}

            document.getElementById('intro-sequence').style.display = 'flex';
            document.getElementById('slide-container').style.display = 'none';
            document.getElementById('intro-title').innerText = deck.display_name || "Mystery Presentation";
            document.getElementById('intro-author').innerText = "By: " + (deck.author_name || "Unknown");
            
            // Background load
            const loadingTask = pdfjsLib.getDocument(\`/api/file/\${deck.id}\`);
            loadingTask.promise.then(pdf => {
                pdfDoc = pdf;
                pageNum = 1;
            }).catch(err => alert("Error downloading slides: " + err.message));

            let count = 3;
            const countEl = document.getElementById('intro-countdown');
            countEl.innerText = count;
            
            const timer = setInterval(() => {
                count--;
                if(count > 0) countEl.innerText = count;
                else if (count === 0) countEl.innerText = "START!";
                else {
                    clearInterval(timer);
                    document.getElementById('intro-sequence').style.display = 'none';
                    document.getElementById('slide-container').style.display = 'flex';
                    inPresentationMode = true;
                    showControlsTrack(); // Trigger initial toolbar reveal
                    if(pdfDoc) renderPage(pageNum);
                }
            }, 1000);
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

                const renderContext = { canvasContext: ctx, viewport: scaledViewport };
                const renderTask = page.render(renderContext);

                renderTask.promise.then(() => {
                    pageRendering = false;
                    document.getElementById('page-indicator').innerText = \`\${pageNum} / \${pdfDoc.numPages}\`;
                    if (pageNumPending !== null) {
                        renderPage(pageNumPending);
                        pageNumPending = null;
                    }
                });
            });
            triggerTransitionsManager();
        }

        function queueRenderPage(num) {
            if (pageRendering) pageNumPending = num;
            else renderPage(num);
        }

        function prevSlide() {
            if (pageNum <= 1) return;
            pageNum--;
            queueRenderPage(pageNum);
        }

        function nextSlide() {
            if (pageNum >= pdfDoc.numPages) return;
            pageNum++;
            queueRenderPage(pageNum);
        }

        const goofyEffects = ['anim-spin', 'anim-barrel', 'anim-hinge', 'anim-wobble', 'anim-zoom', 'anim-pageflip', 'anim-implode'];

        function triggerTransitionsManager() {
            const isReduced = document.getElementById('reduced-motion-cb').checked;
            
            canvas.classList.remove(...goofyEffects, 'anim-basic-fade');
            void canvas.offsetWidth; 
            
            if (isReduced) {
                canvas.classList.add('anim-basic-fade');
            } else {
                const fx = goofyEffects[Math.floor(Math.random() * goofyEffects.length)];
                canvas.classList.add(fx);
            }
        }

        window.addEventListener('keydown', (e) => {
            if (!inPresentationMode) return;

            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                nextSlide();
            } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
                e.preventDefault();
                prevSlide();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                killPlayback();
            }
        });

        function showControlsTrack() {
            floatingBar.classList.remove('hidden');
            clearTimeout(controlsTimeout);
            
            controlsTimeout = setTimeout(() => {
                if (inPresentationMode) {
                    floatingBar.classList.add('hidden');
                }
            }, 2000);
        }

        document.getElementById('slide-container').addEventListener('mousemove', showControlsTrack);

        function killPlayback() {
            inPresentationMode = false;
            clearTimeout(controlsTimeout);
            document.getElementById('fullscreen-stage').style.display = 'none';
            document.getElementById('main-dashboard').style.display = 'grid';
            if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
            pdfDoc = null;
        }

        window.onload = fetchPoolList;
    </script>
</body>
</html>
`;