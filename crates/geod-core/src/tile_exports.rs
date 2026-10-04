//! Agent tile container/export contract v1. GeoD desktop 3.6.10 is the
//! compatibility baseline: global EPSG:3857 matrices, XYZ GPKG, TMS MBTiles.
use super::*;

pub(super) struct ExtraTileWriter {
    gpkg: Option<Connection>, raw: Option<Connection>, root: PathBuf,
}
impl ExtraTileWriter {
    pub(super) fn new(root: &Path, source: &HttpSource, request: &ImageryRequest) -> Result<Self, CoreError> {
        let gpkg = if request.extra_outputs.contains(&ExtraOutput::GeoPackage) {
            let conn = Connection::open(root.join("imagery.gpkg")).map_err(io_error)?;
            conn.execute_batch("PRAGMA application_id=1196444487; PRAGMA user_version=10300;
                CREATE TABLE gpkg_spatial_ref_sys(srs_name TEXT NOT NULL,srs_id INTEGER PRIMARY KEY,organization TEXT NOT NULL,organization_coordsys_id INTEGER NOT NULL,definition TEXT NOT NULL,description TEXT);
                CREATE TABLE gpkg_contents(table_name TEXT PRIMARY KEY,data_type TEXT NOT NULL,identifier TEXT UNIQUE,description TEXT,last_change TEXT NOT NULL,min_x REAL,min_y REAL,max_x REAL,max_y REAL,srs_id INTEGER);
                CREATE TABLE gpkg_tile_matrix_set(table_name TEXT PRIMARY KEY,srs_id INTEGER NOT NULL,min_x REAL NOT NULL,min_y REAL NOT NULL,max_x REAL NOT NULL,max_y REAL NOT NULL);
                CREATE TABLE gpkg_tile_matrix(table_name TEXT NOT NULL,zoom_level INTEGER NOT NULL,matrix_width INTEGER NOT NULL,matrix_height INTEGER NOT NULL,tile_width INTEGER NOT NULL,tile_height INTEGER NOT NULL,pixel_x_size REAL NOT NULL,pixel_y_size REAL NOT NULL,PRIMARY KEY(table_name,zoom_level));
                CREATE TABLE tiles(id INTEGER PRIMARY KEY,zoom_level INTEGER NOT NULL,tile_column INTEGER NOT NULL,tile_row INTEGER NOT NULL,tile_data BLOB NOT NULL,UNIQUE(zoom_level,tile_column,tile_row));
                INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined cartesian',-1,'NONE',-1,'undefined',NULL),('Undefined geographic',0,'NONE',0,'undefined',NULL);").map_err(io_error)?;
            let wkt = "PROJCS[\"WGS 84 / Pseudo-Mercator\",GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Mercator_1SP\"],PARAMETER[\"central_meridian\",0],PARAMETER[\"scale_factor\",1],PARAMETER[\"false_easting\",0],PARAMETER[\"false_northing\",0],UNIT[\"metre\",1]]";
            conn.execute("INSERT INTO gpkg_spatial_ref_sys VALUES('WGS 84 / Pseudo-Mercator',3857,'EPSG',3857,?1,NULL)", [wkt]).map_err(io_error)?;
            let world = 2.0 * std::f64::consts::PI * 6_378_137.0;
            let project = |lon: f64, lat: f64| (lon.to_radians() * 6_378_137.0, lat.to_radians().tan().asinh() * 6_378_137.0);
            let (min_x, min_y) = project(request.bounds[0], request.bounds[1]);
            let (max_x, max_y) = project(request.bounds[2], request.bounds[3]);
            conn.execute("INSERT INTO gpkg_contents VALUES('tiles','tiles',?1,?2,?3,?4,?5,?6,?7,3857)",
                params![request.name, source.attribution, Utc::now().to_rfc3339(), min_x, min_y, max_x, max_y]).map_err(io_error)?;
            conn.execute("INSERT INTO gpkg_tile_matrix_set VALUES('tiles',3857,?1,?1,?2,?2)", params![-world/2.0, world/2.0]).map_err(io_error)?;
            for grid in &request.grids {
                let dimension = 1u64 << grid.zoom;
                let resolution = world / dimension as f64 / f64::from(source.tile_size);
                conn.execute("INSERT INTO gpkg_tile_matrix VALUES('tiles',?1,?2,?2,?3,?3,?4,?4)", params![grid.zoom, dimension, source.tile_size, resolution]).map_err(io_error)?;
            }
            conn.execute_batch("BEGIN IMMEDIATE").map_err(io_error)?;
            Some(conn)
        } else { None };
        let raw = if request.extra_outputs.contains(&ExtraOutput::Tiles) {
            let conn = Connection::open(root.join("tiles-index.sqlite")).map_err(io_error)?;
            conn.execute_batch("CREATE TABLE tiles(zoom INTEGER,x INTEGER,y INTEGER,path TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(zoom,x,y)); BEGIN IMMEDIATE").map_err(io_error)?;
            Some(conn)
        } else { None };
        Ok(Self { gpkg, raw, root: root.to_path_buf() })
    }
    pub(super) fn put(&mut self, z: u8, x: u32, y: u32, tile: &DownloadedTile) -> Result<(), CoreError> {
        if let Some(conn) = &self.gpkg {
            let bytes = if tile.bytes.starts_with(b"\x89PNG") || tile.bytes.starts_with(b"\xff\xd8") { tile.bytes.clone() } else {
                let mut bytes = Vec::new();
                image::codecs::png::PngEncoder::new(&mut bytes).write_image(tile.image.as_raw(), tile.image.width(), tile.image.height(), image::ExtendedColorType::Rgba8).map_err(io_error)?;
                bytes
            };
            conn.execute("INSERT INTO tiles(zoom_level,tile_column,tile_row,tile_data) VALUES(?1,?2,?3,?4)", params![z,x,y,bytes]).map_err(io_error)?;
        }
        if let Some(conn) = &self.raw {
            let extension = if tile.bytes.starts_with(b"\xff\xd8") { "jpg" } else if tile.bytes.starts_with(b"\x89PNG") { "png" } else { "webp" };
            let relative = format!("tiles/{z}/{x}/{y}.{extension}");
            let path = self.root.join(&relative);
            fs::create_dir_all(path.parent().unwrap()).map_err(io_error)?;
            fs::write(&path, &tile.bytes).map_err(io_error)?;
            conn.execute("INSERT INTO tiles VALUES(?1,?2,?3,?4,?5,?6)", params![z,x,y,relative,tile.bytes.len() as u64,format!("{:x}", Sha256::digest(&tile.bytes))]).map_err(io_error)?;
        }
        Ok(())
    }
    pub(super) fn finish(self) -> Result<Vec<(&'static str, &'static str, &'static str)>, CoreError> {
        let mut outputs = Vec::new();
        for (conn, id, file, mime) in [(self.gpkg, "imagery-gpkg", "imagery.gpkg", "application/geopackage+sqlite3"),
            (self.raw, "raw-tiles-index", "tiles-index.sqlite", "application/vnd.geod.tiles-index+sqlite3")] {
            if let Some(conn) = conn {
                conn.execute_batch("COMMIT").map_err(io_error)?;
                let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(io_error)?;
                if integrity != "ok" { return Err(CoreError::new("ARTIFACT_INCOMPLETE", integrity)); }
                outputs.push((id, file, mime));
            }
        }
        Ok(outputs)
    }
}

pub(super) fn inspect_raw(root: &Path, index: &Path) -> Result<(), CoreError> {
    let conn = Connection::open_with_flags(index, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io_error)?;
    let canonical = fs::canonicalize(root).map_err(io_error)?;
    let mut statement = conn.prepare("SELECT path,bytes,sha256 FROM tiles").map_err(io_error)?;
    let mut rows = statement.query([]).map_err(io_error)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(io_error)? {
        let relative: String = row.get(0).map_err(io_error)?;
        if Path::new(&relative).components().any(|c| !matches!(c, Component::Normal(_))) { return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Unsafe raw tile path")); }
        let file = fs::canonicalize(root.join(relative)).map_err(io_error)?;
        let size: u64 = row.get(1).map_err(io_error)?;
        let hash: String = row.get(2).map_err(io_error)?;
        if !file.starts_with(&canonical) || fs::metadata(&file).map_err(io_error)?.len() != size || sha256_file(&file)? != hash {
            return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Raw tile hash or length mismatch"));
        }
        count += 1;
    }
    if count == 0 { return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Empty raw tile directory")); }
    Ok(())
}
