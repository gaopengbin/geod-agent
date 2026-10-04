\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE ROLE geod_reader LOGIN;
ALTER ROLE geod_reader SET default_transaction_read_only = on;
CREATE SCHEMA demo;
CREATE SCHEMA hidden;

CREATE TABLE demo.boundaries_4326 (id serial PRIMARY KEY, name text, geom geometry(Polygon,4326));
INSERT INTO demo.boundaries_4326(name,geom) VALUES ('北京测试范围',ST_GeomFromText('POLYGON((116.1 39.6,116.3 39.6,116.3 39.8,116.1 39.8,116.1 39.6),(116.15 39.65,116.2 39.65,116.2 39.7,116.15 39.7,116.15 39.65))',4326));
CREATE TABLE demo.boundaries_3857 (id serial PRIMARY KEY, name text, geom geometry(Polygon,3857));
INSERT INTO demo.boundaries_3857(name,geom) SELECT name,ST_Transform(geom,3857) FROM demo.boundaries_4326;
CREATE TABLE demo.multiple_regions (id serial PRIMARY KEY, geom geometry(MultiPolygon,4326));
INSERT INTO demo.multiple_regions(geom) SELECT ST_Multi(ST_Collect(geom,ST_Translate(geom,0.4,0))) FROM demo.boundaries_4326;
CREATE TABLE demo.nullable_area (id serial PRIMARY KEY, geom geometry(Polygon,4326), backup_geom geometry(Polygon,3857));
INSERT INTO demo.nullable_area(geom,backup_geom) SELECT geom,ST_Transform(geom,3857) FROM demo.boundaries_4326;
INSERT INTO demo.nullable_area(geom,backup_geom) VALUES (NULL,NULL);
CREATE TABLE demo.empty_area (geom geometry(Polygon,4326));
CREATE TABLE demo.points (geom geometry(Point,4326));
INSERT INTO demo.points VALUES (ST_SetSRID(ST_MakePoint(116.2,39.7),4326));
CREATE TABLE demo.invalid_area (geom geometry(Polygon,4326));
INSERT INTO demo.invalid_area VALUES (ST_GeomFromText('POLYGON((116.1 39.6,116.3 39.8,116.3 39.6,116.1 39.8,116.1 39.6))',4326));
CREATE TABLE demo.unknown_crs (geom geometry(Polygon,0));
INSERT INTO demo.unknown_crs SELECT ST_SetSRID(geom,0) FROM demo.boundaries_4326;
CREATE TABLE demo.big_area (id integer, geom geometry(Polygon,4326));
INSERT INTO demo.big_area SELECT i,geom FROM demo.boundaries_4326 CROSS JOIN generate_series(1,10001) i;
CREATE VIEW demo.projected_view AS SELECT id,name,ST_Transform(geom,4326)::geometry(Polygon,4326) geom FROM demo.boundaries_3857;
CREATE TABLE demo."区划 odd"" table" ("边界 odd" geometry(Polygon,4326));
INSERT INTO demo."区划 odd"" table" SELECT geom FROM demo.boundaries_4326;

CREATE TABLE hidden.private_area (geom geometry(Polygon,4326));
INSERT INTO hidden.private_area SELECT geom FROM demo.boundaries_4326;
CREATE TABLE demo.scoped_regions (scope text,geom geometry(Polygon,4326));
INSERT INTO demo.scoped_regions SELECT 'visible',geom FROM demo.boundaries_4326;
INSERT INTO demo.scoped_regions SELECT 'private',ST_Translate(geom,1,1) FROM demo.boundaries_4326;
ALTER TABLE demo.scoped_regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader_scope ON demo.scoped_regions FOR SELECT TO geod_reader USING (scope='visible');

GRANT CONNECT ON DATABASE geod_test TO geod_reader;
GRANT USAGE ON SCHEMA demo TO geod_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA demo TO geod_reader;
