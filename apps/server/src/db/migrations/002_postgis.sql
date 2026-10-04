-- @optional: applied only when the PostGIS extension is available (e.g. docker-compose postgis image).
-- Adds geodetic geometry columns for GIS interoperability (QGIS, ogr2ogr). The application's own spatial
-- queries use the local ENU frame and do not depend on PostGIS.
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE observations ADD COLUMN geom geometry(Point, 4326)
  GENERATED ALWAYS AS (CASE WHEN lon IS NOT NULL AND lat IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326) END) STORED;
CREATE INDEX observations_geom ON observations USING gist (geom);
