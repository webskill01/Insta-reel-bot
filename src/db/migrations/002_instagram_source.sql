-- Instagram source pages: youtube_id holds the IG media id, source_url the CDN mp4 (expires, refreshed by re-scan)
ALTER TABLE videos ADD COLUMN source_url TEXT;
ALTER TABLE videos ADD COLUMN permalink TEXT;
