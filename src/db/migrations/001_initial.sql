PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ig_user_id      TEXT NOT NULL UNIQUE,
    ig_username     TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    token_expires   INTEGER NOT NULL,
    token_refreshed INTEGER NOT NULL,
    niche           TEXT NOT NULL,
    max_posts_day   INTEGER NOT NULL DEFAULT 3,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id       TEXT NOT NULL UNIQUE,
    channel_name     TEXT NOT NULL,
    uploads_playlist TEXT,
    niche            TEXT NOT NULL,
    etag             TEXT,
    last_scanned     INTEGER DEFAULT 0,
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS account_channels (
    account_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, channel_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id      TEXT NOT NULL UNIQUE,
    channel_id      TEXT NOT NULL,
    title           TEXT NOT NULL,
    duration_sec    INTEGER NOT NULL,
    niche           TEXT NOT NULL,
    discovered_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    raw_path        TEXT,
    processed_path  TEXT,
    status          TEXT NOT NULL DEFAULT 'discovered',
    error_message   TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    locked_by       TEXT,
    locked_at       INTEGER,
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_niche_status ON videos(niche, status);
CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id);

CREATE TABLE IF NOT EXISTS posts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id        INTEGER NOT NULL,
    account_id      INTEGER NOT NULL,
    ig_container_id TEXT,
    ig_media_id     TEXT,
    caption         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    scheduled_at    INTEGER,
    published_at    INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (video_id) REFERENCES videos(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    UNIQUE(video_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_account_status ON posts(account_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);

CREATE TABLE IF NOT EXISTS daily_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    date        TEXT NOT NULL,
    posts_count INTEGER NOT NULL DEFAULT 0,
    failures    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, date),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS token_refreshes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    INTEGER NOT NULL,
    old_expires   INTEGER NOT NULL,
    new_expires   INTEGER NOT NULL,
    refreshed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    success       INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS etag_cache (
    cache_key     TEXT PRIMARY KEY,
    etag          TEXT NOT NULL,
    response_json TEXT NOT NULL,
    cached_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
