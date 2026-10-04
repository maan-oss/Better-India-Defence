-- Live camera sources (RTSP / HTTP / file) analysed on site. A source either drives an existing site camera
-- (binding = 'site') or adds a new camera to the site with its own surveyed pose (binding = 'new').
CREATE TABLE camera_sources (
  id text PRIMARY KEY,                 -- sensor id used for observations, e.g. C05 or GATE2-CAM1
  name text NOT NULL,
  binding text NOT NULL CHECK (binding IN ('site', 'new')),
  url_enc text NOT NULL,               -- AES-256-GCM (base64) when STORAGE_ENCRYPTION_KEY is set, else 'plain:' + url
  enabled boolean NOT NULL DEFAULT true,
  pose jsonb,                          -- {lat, lon, heightM, headingDeg, pitchDeg, hfovDeg} for binding = 'new'
  segment text NOT NULL DEFAULT 'core',
  zone_id text,
  analytics_fps real NOT NULL DEFAULT 2,
  detect_objects boolean NOT NULL DEFAULT true,
  recognise_faces boolean NOT NULL DEFAULT true,
  tiled boolean NOT NULL DEFAULT false,
  loop_file boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
