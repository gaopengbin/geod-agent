//! GeoPackage 1.4 feature table using standard GeoPackageBinary + OGC WKB.
use crate::{Error, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

pub struct Writer {
    db: Connection,
    count: u64,
    bounds: Option<[f64; 4]>,
}
impl Writer {
    pub fn new(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA application_id=1196444487; PRAGMA user_version=10400;
          CREATE TABLE gpkg_spatial_ref_sys(srs_name TEXT NOT NULL,srs_id INTEGER NOT NULL PRIMARY KEY,organization TEXT NOT NULL,organization_coordsys_id INTEGER NOT NULL,definition TEXT NOT NULL,description TEXT);
          CREATE TABLE gpkg_contents(table_name TEXT NOT NULL PRIMARY KEY,data_type TEXT NOT NULL,identifier TEXT UNIQUE,description TEXT DEFAULT '',last_change DATETIME NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),min_x DOUBLE,min_y DOUBLE,max_x DOUBLE,max_y DOUBLE,srs_id INTEGER,FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
          CREATE TABLE gpkg_geometry_columns(table_name TEXT NOT NULL,column_name TEXT NOT NULL,geometry_type_name TEXT NOT NULL,srs_id INTEGER NOT NULL,z TINYINT NOT NULL,m TINYINT NOT NULL,CONSTRAINT pk_geom_cols PRIMARY KEY(table_name,column_name),CONSTRAINT uk_gc_table_name UNIQUE(table_name),FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name),FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
          CREATE TABLE features(fid INTEGER PRIMARY KEY AUTOINCREMENT,geom GEOMETRY NOT NULL,source_id TEXT,source_layer TEXT,properties TEXT NOT NULL);
          INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined Cartesian',-1,'NONE',-1,'undefined','undefined Cartesian'),('Undefined geographic',0,'NONE',0,'undefined','undefined geographic');
          ")?;
        db.execute("INSERT INTO gpkg_spatial_ref_sys VALUES('WGS 84',4326,'EPSG',4326,?1,'longitude/latitude')",["GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433],AUTHORITY[\"EPSG\",\"4326\"]]"])?;
        db.execute_batch("INSERT INTO gpkg_contents(table_name,data_type,identifier,description,srs_id) VALUES('features','features','GeoD vector features','Original feature properties are preserved in the properties JSON field',4326); INSERT INTO gpkg_geometry_columns VALUES('features','geom','GEOMETRY',4326,0,0); BEGIN IMMEDIATE;")?;
        Ok(Self {
            db,
            count: 0,
            bounds: None,
        })
    }
    pub fn insert(&mut self, feature: &Value) -> Result<()> {
        let geometry = feature
            .get("geometry")
            .ok_or_else(|| Error::InvalidData("Feature has no geometry".into()))?;
        let bounds = geometry_bounds(geometry)?;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GP");
        bytes.extend_from_slice(&[0, 3]); // v0, little endian, XY envelope
        bytes.extend_from_slice(&4326i32.to_le_bytes());
        for value in [bounds[0], bounds[2], bounds[1], bounds[3]] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        write_wkb(geometry, &mut bytes)?;
        let id = feature.get("id").map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        });
        let props = &feature["properties"];
        self.db.execute(
            "INSERT INTO features(geom,source_id,source_layer,properties) VALUES(?1,?2,?3,?4)",
            params![
                bytes,
                id,
                props["_sourceLayer"].as_str(),
                serde_json::to_string(props)?
            ],
        )?;
        self.bounds = Some(match self.bounds {
            None => bounds,
            Some(b) => [
                b[0].min(bounds[0]),
                b[1].min(bounds[1]),
                b[2].max(bounds[2]),
                b[3].max(bounds[3]),
            ],
        });
        self.count += 1;
        Ok(())
    }
    pub fn finish(self) -> Result<()> {
        if let Some(b) = self.bounds {
            self.db.execute("UPDATE gpkg_contents SET min_x=?1,min_y=?2,max_x=?3,max_y=?4 WHERE table_name='features'",params![b[0],b[1],b[2],b[3]])?;
        }
        self.db.execute_batch("COMMIT; PRAGMA optimize;")?;
        Ok(())
    }
}

pub fn geometry_bounds(geometry: &Value) -> Result<[f64; 4]> {
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    fn walk(value: &Value, bounds: &mut [f64; 4]) -> Result<()> {
        let arr = value
            .as_array()
            .ok_or_else(|| Error::InvalidData("Invalid geometry coordinates".into()))?;
        if arr.first().is_some_and(Value::is_number) {
            if arr.len() != 2 {
                return Err(Error::InvalidData("Only XY positions are supported".into()));
            }
            let x = arr[0].as_f64().unwrap_or(f64::NAN);
            let y = arr[1].as_f64().unwrap_or(f64::NAN);
            if !x.is_finite()
                || !y.is_finite()
                || !(-540.0..=540.0).contains(&x)
                || !(-90.0..=90.0).contains(&y)
            {
                return Err(Error::InvalidData("Invalid geographic coordinate".into()));
            }
            bounds[0] = bounds[0].min(x);
            bounds[1] = bounds[1].min(y);
            bounds[2] = bounds[2].max(x);
            bounds[3] = bounds[3].max(y);
        } else {
            for child in arr {
                walk(child, bounds)?;
            }
        }
        Ok(())
    }
    if geometry["type"] == "GeometryCollection" {
        for g in geometry["geometries"]
            .as_array()
            .ok_or_else(|| Error::InvalidData("Missing geometries".into()))?
        {
            let b = geometry_bounds(g)?;
            bounds[0] = bounds[0].min(b[0]);
            bounds[1] = bounds[1].min(b[1]);
            bounds[2] = bounds[2].max(b[2]);
            bounds[3] = bounds[3].max(b[3]);
        }
    } else {
        walk(&geometry["coordinates"], &mut bounds)?;
    }
    if !bounds[0].is_finite() {
        return Err(Error::InvalidData("Empty feature geometry".into()));
    }
    Ok(bounds)
}
fn write_wkb(g: &Value, out: &mut Vec<u8>) -> Result<()> {
    let kind = g["type"]
        .as_str()
        .ok_or_else(|| Error::InvalidData("Missing geometry type".into()))?;
    let code = match kind {
        "Point" => 1u32,
        "LineString" => 2,
        "Polygon" => 3,
        "MultiPoint" => 4,
        "MultiLineString" => 5,
        "MultiPolygon" => 6,
        "GeometryCollection" => 7,
        _ => return Err(Error::InvalidData(format!("Unsupported geometry {kind}"))),
    };
    out.push(1);
    out.extend_from_slice(&code.to_le_bytes());
    let coords = &g["coordinates"];
    fn arr(v: &Value) -> Result<&Vec<Value>> {
        v.as_array()
            .ok_or_else(|| Error::InvalidData("Invalid coordinate array".into()))
    }
    fn count(n: usize, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(
            &u32::try_from(n)
                .map_err(|_| Error::InvalidData("Geometry too large".into()))?
                .to_le_bytes(),
        );
        Ok(())
    }
    fn point(v: &Value, out: &mut Vec<u8>) -> Result<()> {
        let p = arr(v)?;
        if p.len() != 2 {
            return Err(Error::InvalidData("Expected XY point".into()));
        }
        for n in p {
            let n = n
                .as_f64()
                .ok_or_else(|| Error::InvalidData("Invalid coordinate".into()))?;
            out.extend_from_slice(&n.to_le_bytes());
        }
        Ok(())
    }
    match code {
        1 => point(coords, out)?,
        2 => {
            let line = arr(coords)?;
            count(line.len(), out)?;
            for p in line {
                point(p, out)?;
            }
        }
        3 => {
            let poly = arr(coords)?;
            count(poly.len(), out)?;
            for ring in poly {
                let ring = arr(ring)?;
                count(ring.len(), out)?;
                for p in ring {
                    point(p, out)?;
                }
            }
        }
        4..=6 => {
            let parts = arr(coords)?;
            count(parts.len(), out)?;
            let child = match code {
                4 => "Point",
                5 => "LineString",
                _ => "Polygon",
            };
            for p in parts {
                write_wkb(&serde_json::json!({"type":child,"coordinates":p}), out)?;
            }
        }
        7 => {
            let parts = arr(&g["geometries"])?;
            count(parts.len(), out)?;
            for p in parts {
                write_wkb(p, out)?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}
