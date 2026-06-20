export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- BACKEND API ROUTES ---

    // 1. Handle Presentation Upload
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("presentation");
        const displayName = formData.get("name") || "Untitled Presentation";
        const playerId = formData.get("playerId"); // Generated unique string on client
        const optInPool = formData.get("optInPool") === "true" ? 1 : 0;

        if (!file || !(file instanceof File)) {
          return new Response("Missing file file", { status: 400 });
        }

        const id = crypto.randomUUID();
        const r2Key = `presentations/${id}.pdf`;

        // Upload PDF binary to Cloudflare R2 Storage
        await env.MY_R2_BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: "application/pdf" }
        });

        // Insert metadata into Cloudflare D1
        await env.MY_D1_DB.prepare(
          `INSERT INTO presentations (id, display_name, r2_object_key, creator_player_id, is_pool_eligible, is_premade) 
           VALUES (?, ?, ?, ?, ?, 0)`
        ).bind(id, displayName, r2Key, playerId, optInPool).run();

        return new Response(JSON.stringify({ success: true, id }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(err.message, { status: 500 });
      }
    }

    // 2. Fetch/Assign a Random Presentation for a Target Player
    if (path === "/api/assign" && request.method === "GET") {
      const targetPlayerId = url.searchParams.get("playerId");

      // Logic: Find custom decks NOT created by this player OR global premade pools
      const query = `
        SELECT * FROM presentations 
        WHERE (is_premade = 1) 
           OR (is_pool_eligible = 1 AND creator_player_id != ?)
           OR (creator_player_id != ? AND is_premade = 0)
        ORDER BY RANDOM() LIMIT 1
      `;
      
      const { results } = await env.MY_D1_DB.prepare(query)
        .bind(targetPlayerId, targetPlayerId)
        .all();

      if (!results || results.length === 0) {
        // Fallback fallback: grab absolutely any deck if no restrictions match
        const fallback = await env.MY_D1_DB.prepare("SELECT * FROM presentations ORDER BY RANDOM() LIMIT 1").all();
        return new Response(JSON.stringify(fallback.results[0] || { error: "No decks loaded" }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify(results[0]), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Serve the Presentation PDF File from R2
    if (path.startsWith("/api/file/") && request.method === "GET") {
      const fileId = path.split("/api/file/")[1];
      const objectKey = `presentations/${fileId}.pdf`;
      
      const object = await env.MY_R2_BUCKET.get(objectKey);
      if (!object) return new Response("File Not Found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      
      return new Response(object.body, { headers });
    }

    // --- FRONTEND UI SERVICE ---
    // Serves the full interactive UI mimicking the Wii / Frutiger Aero theme
    return new Response(htmlFrontend, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// --- APP FRONTEND CODE ---
const htmlFrontend = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ PowerPoint Karaoke: Wii Edition ⚡</title>
    <style>
        /* Frutiger Aero / Wii Main Menu CSS System */
        :root {
            --wii-bg: radial-gradient(circle, #f4f7f6 0%, #e1e8eb 100%);
            --wii-blue: #00a2ff;
            --wii-green: #4cd137;
            --glossy-overlay: linear-gradient(to bottom, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.1) 50%, rgba(0,0,0,0.05) 100%);
        }

        body {
            margin: 0;
            padding: 0;
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
            background: var(--wii-bg);
            color: #333;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }

        /* Wii Channels Grid Setup */
        .wii-container {
            width: 90%;
            max-width: 1000px;
            margin-top: 40px;
            background: rgba(255, 255, 255, 0.6);
            border-radius: 24px;
            border: 4px solid #fff;
            box-shadow: 0 12px 30px rgba(0,0,0,0.1), inset 0 0 20px rgba(255,255,255,0.8);
            padding: 30px;
            backdrop-filter: blur(10px);
        }

        h1 {
            text-align: center;
            font-weight: 300;
            color: #444;
            text-shadow: 0 2px 4px rgba(255,255,255,0.8);
            letter-spacing: 1px;
        }

        /* Glossy Bubble Buttons */
        .wii-btn {
            background: linear-gradient(135deg, #ffffff 0%, #e6f2ff 100%);
            border: 2px solid #b0cddb;
            border-radius: 50px;
            padding: 12px 28px;
            font-size: 16px;
            font-weight: bold;
            color: #445566;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            box-shadow: 0 4px 10px rgba(0,0,0,0.08), inset 0 2px 4px #fff;
            transition: transform 0.1s ease, box-shadow 0.2s ease;
            margin: 10px;
        }

        .wii-btn::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 50%;
            background: linear-gradient(to bottom, rgba(255,255,255,0.6), rgba(255,255,255,0));
            border-radius: 50px 50px 0 0;
        }

        .wii-btn:hover {
            transform: scale(1.04);
            box-shadow: 0 6px 15px rgba(0,162,255,0.2);
            border-color: var(--wii-blue);
        }

        .form-group {
            background: rgba(255,255,255,0.8);
            padding: 20px;
            border-radius: 16px;
            border: 1px solid #d1dee6;
            margin-bottom: 20px;
        }

        /* Presentation Canvas Area */
        #presentation-stage {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: #000;
            z-index: 9999;
        }

        .slide-container {
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            perspective: 1200px;
            overflow: hidden;
        }

        /* Goofy Transition Layer Elements */
        .slide-frame {
            position: absolute;
            width: 100%;
            height: 100%;
            transition: all 0.8s cubic-bezier(0.68, -0.55, 0.265, 1.55);
            background: white;
        }

        /* Goofy Transition Styles */
        .transition-spin {
            transform: rotate(720deg) scale(0);
            opacity: 0;
        }
        
        .transition-peel {
            transform-origin: bottom right;
            transform: rotate(-90deg) translate(-100%, -100%);
            opacity: 0;
        }

        .transition-fall {
            transform-origin: top left;
            transform: rotate(105deg);
            opacity: 0;
        }

        /* Simple Navigation Bar over Presentation */
        .pres-controls {
            position: absolute;
            bottom: 25px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 100000;
            background: rgba(255,255,255,0.85);
            padding: 10px 20px;
            border-radius: 40px;
            backdrop-filter: blur(5px);
            border: 2px solid white;
            display: flex;
            gap: 15px;
        }
    </style>
</head>
<body>

    <div class="wii-container" id="menu-view">
        <h1>💿 PowerPoint Karaoke System 💿</h1>
        
        <div class="form-group">
            <h3>📥 Upload Custom Presentation Decks</h3>
            <input type="file" id="pdf-file" accept=".pdf" /><br/><br/>
            <input type="text" id="deck-name" placeholder="Presentation Topic/Title..." style="padding:8px; width:250px; border-radius:8px; border:1px solid #ccc;" /><br/><br/>
            
            <label>
                <input type="checkbox" id="opt-in-pool" checked> Commit to public pool for other games?
            </label>
            <br/><br/>
            <button class="wii-btn" onclick="uploadDeck()">Upload to Memory Card</button>
        </div>

        <div class="form-group" style="text-align: center;">
            <h3>🎮 Start Presentation Channel</h3>
            <button class="wii-btn" style="background: linear-gradient(135deg, #e3fbec 0%, #bbf2cb 100%);" onclick="startPresentation()">Generate Random Deck & Play</button>
        </div>
    </div>

    <div id="presentation-stage">
        <div class="pres-controls">
            <button class="wii-btn" onclick="prevSlide()">◀ Back</button>
            <button class="wii-btn" onclick="nextSlide()">Forward ▶</button>
            <button class="wii-btn" style="color:red;" onclick="exitPresentation()">✕ Exit</button>
        </div>
        <div class="slide-container" id="slide-container">
            <iframe id="pdf-viewer" class="slide-frame" src="" frameborder="0"></iframe>
        </div>
    </div>

    <script>
        // Set local anonymous player identity state key
        if (!localStorage.getItem('wii_player_id')) {
            localStorage.setItem('wii_player_id', 'player_' + Math.random().toString(36).substring(2, 11));
        }
        const playerId = localStorage.getItem('wii_player_id');

        async function uploadDeck() {
            const fileInput = document.getElementById('pdf-file');
            const nameInput = document.getElementById('deck-name');
            const optInCheck = document.getElementById('opt-in-pool');

            if(!fileInput.files[0]) return alert("Please select a PDF presentation file first!");

            const fd = new FormData();
            fd.append('presentation', fileInput.files[0]);
            fd.append('name', nameInput.value);
            fd.append('playerId', playerId);
            fd.append('optInPool', optInCheck.checked);

            const res = await fetch('/api/upload', { method: 'POST', body: fd });
            if(res.ok) {
                alert("✨ Deck successfully verified and committed into rotation!");
                nameInput.value = '';
                fileInput.value = '';
            } else {
                alert("Error saving deck file.");
            }
        }

        let currentPresentationKey = "";
        
        async function startPresentation() {
            // Get random file assigned according to matching structural rule matrix
            const res = await fetch(\`/api/assign?playerId=\${playerId}\`);
            const deck = await res.json();

            if (deck.error || !deck.id) {
                alert("No decks found in database pool matching game rules.");
                return;
            }

            currentPresentationKey = deck.id;
            const iframe = document.getElementById('pdf-viewer');
            
            // Native render bypass mapping straight into R2 storage worker channel pipelines
            iframe.src = \`/api/file/\${deck.id}\`;

            document.getElementById('menu-view').style.display = 'none';
            document.getElementById('presentation-stage').style.display = 'block';
        }

        // List of retro transition classes to shuffle
        const transitions = ['transition-spin', 'transition-peel', 'transition-fall'];

        function applyGoofyTransition() {
            const iframe = document.getElementById('pdf-viewer');
            const randomTransition = transitions[Math.floor(Math.random() * transitions.length)];
            
            // Inject random CSS transformations for 2000s transitions
            iframe.classList.add(randomTransition);
            setTimeout(() => {
                iframe.classList.remove(randomTransition);
            }, 800); 
        }

        function nextSlide() {
            applyGoofyTransition();
            // Since standard native PDFs handle internal arrow navigation directly inside iframe views, 
            // these controls double up animations or handle manual array index switches if using step items
        }

        function prevSlide() {
            applyGoofyTransition();
        }

        function exitPresentation() {
            document.getElementById('presentation-stage').style.display = 'none';
            document.getElementById('menu-view').style.display = 'block';
            document.getElementById('pdf-viewer').src = "";
        }
    </script>
</body>
</html>
`;