-- Table to store both premade and custom uploaded presentations
CREATE TABLE presentations (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    r2_object_key TEXT NOT NULL,     -- The filename inside Cloudflare R2
    creator_player_id TEXT,          -- Anonymous ID/Cookie of creator (NULL if premade)
    is_pool_eligible BOOLEAN DEFAULT 0, -- 1 if user opted-in to commit it to the global pool
    is_premade BOOLEAN DEFAULT 0    -- 1 if seeded by you natively
);

-- Table to manage game sessions
CREATE TABLE game_sessions (
    session_id TEXT PRIMARY KEY,
    current_presentation_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(current_presentation_id) REFERENCES presentations(id)
);