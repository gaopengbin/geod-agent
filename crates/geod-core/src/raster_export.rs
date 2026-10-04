//! Bounded-memory raster export, contract v1.
//! Uses GeoD desktop's strip-based export approach (MIT, 3.6.10), independently
//! implemented against Agent tile geometry and its polygon/hole mask contract.
use super::*;
use std::collections::HashMap;
use std::io::BufWriter;
use tiff::encoder::compression::{CompressionAlgorithm, Lzw, Deflate};

const STRIP_BUDGET: u64 = 32 * 1024 * 1024;

pub(super) struct TileSpool {
    root: tempfile::TempDir,
    paths: HashMap<(u32, u32), PathBuf>,
}

impl TileSpool {
    pub(super) fn new(parent: &Path) -> Result<Self, CoreError> {
        Ok(Self { root: tempfile::Builder::new().prefix(".raster-tiles-").tempdir_in(parent).map_err(io_error)?, paths: HashMap::new() })
    }
    pub(super) fn save(&mut self, x: u32, y: u32, bytes: &[u8], existing: Option<PathBuf>) -> Result<(), CoreError> {
        let path = if let Some(path) = existing { path } else {
            let path = self.root.path().join(format!("{x}-{y}.tile"));
            fs::write(&path, bytes).map_err(io_error)?;
            path
        };
        self.paths.insert((x, y), path);
        Ok(())
    }
    fn strip(&self, grid: &TileGrid, crop: &PixelCrop, tile_size: u16, row: u32, height: u32) -> Result<RgbaImage, CoreError> {
        let size = u32::from(tile_size);
        let mut strip = RgbaImage::new(crop.width, height);
        let top = crop.top + row;
        let bottom = top + height;
        let first_y = grid.y_min + top / size;
        let last_y = grid.y_min + (bottom - 1) / size;
        let first_x = grid.x_min + crop.left / size;
        let last_x = grid.x_min + (crop.left + crop.width - 1) / size;
        for y in first_y..=last_y {
            for x in first_x..=last_x {
                let Some(path) = self.paths.get(&(x, y)) else { continue; };
                let bytes = fs::read(path).map_err(io_error)?;
                let tile = image::load_from_memory(&bytes).map_err(io_error)?.to_rgba8();
                if tile.dimensions() != (size, size) { return Err(CoreError::new("INVALID_TILE", "Spool tile dimensions changed")); }
                let tile_left = (x - grid.x_min) * size;
                let tile_top = (y - grid.y_min) * size;
                let left = crop.left.max(tile_left);
                let right = (crop.left + crop.width).min(tile_left + size);
                let start_y = top.max(tile_top);
                let end_y = bottom.min(tile_top + size);
                for sy in start_y..end_y {
                    let from = ((sy - tile_top) as usize * size as usize + (left - tile_left) as usize) * 4;
                    let to = ((sy - top) as usize * crop.width as usize + (left - crop.left) as usize) * 4;
                    let count = (right - left) as usize * 4;
                    strip.as_mut()[to..to + count].copy_from_slice(&tile.as_raw()[from..from + count]);
                }
            }
        }
        Ok(strip)
    }
}

/// Every strip and compression buffer is bounded independently of raster height.
/// Cancellation remains responsive during export; an interrupted stage is never published.
pub(super) fn write_streaming_tiff<F>(path: &Path, spool: &TileSpool, grid: &TileGrid, crop: &PixelCrop, tile_size: u16,
    boundary: Option<&BoundaryGeometry>, compression: TiffCompression, pyramid: bool, mut check: F) -> Result<RgbaImage, CoreError>
where F: FnMut() -> Result<(), CoreError> {
    let row_bytes = u64::from(crop.width).checked_mul(4).ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Raster row overflow"))?;
    if row_bytes > STRIP_BUDGET { return Err(CoreError::new("RESOURCE_LIMIT", "Raster is too wide for a bounded export strip; split the region")); }
    let rows = (STRIP_BUDGET / row_bytes).min(u64::from(tile_size)).max(1) as u32;
    let mut preview = if crop.width <= 1024 && crop.height <= 1024 { RgbaImage::new(crop.width, crop.height) } else {
        let scale = 1024.0 / f64::from(crop.width.max(crop.height));
        RgbaImage::new((f64::from(crop.width) * scale).round().max(1.0) as u32, (f64::from(crop.height) * scale).round().max(1.0) as u32)
    };
    let mut writer = BufWriter::new(File::create(path).map_err(io_error)?);
    let mut encoder = TiffEncoder::new_big(&mut writer).map_err(io_error)?;
    let mut directory = encoder.new_directory().map_err(io_error)?;
    let mut offsets = Vec::<u64>::new();
    let mut counts = Vec::<u64>::new();
    let mut preview_y = 0;
    for row in (0..crop.height).step_by(rows as usize) {
        check()?;
        let height = rows.min(crop.height - row);
        let mut strip = spool.strip(grid, crop, tile_size, row, height)?;
        if let Some(boundary) = boundary { mask_rgba(&mut strip, boundary, grid, tile_size, crop.left, crop.top + row); }
        while preview_y < preview.height() {
            let source_y = (u64::from(preview_y) * u64::from(crop.height) / u64::from(preview.height())) as u32;
            if source_y >= row + height { break; }
            for px in 0..preview.width() {
                let source_x = (u64::from(px) * u64::from(crop.width) / u64::from(preview.width())) as u32;
                preview.put_pixel(px, preview_y, *strip.get_pixel(source_x, source_y - row));
            }
            preview_y += 1;
        }
        let mut compressed = Vec::new();
        match compression {
            TiffCompression::Lzw => { Lzw.write_to(&mut compressed, strip.as_raw()).map_err(io_error)?; },
            TiffCompression::Deflate => { Deflate::default().write_to(&mut compressed, strip.as_raw()).map_err(io_error)?; },
            TiffCompression::None => compressed.extend_from_slice(strip.as_raw()),
        }
        offsets.push(directory.write_data(compressed.as_slice()).map_err(io_error)?);
        counts.push(compressed.len() as u64);
    }
    check()?;
    directory.write_tag(Tag::ImageWidth, crop.width).map_err(io_error)?;
    directory.write_tag(Tag::ImageLength, crop.height).map_err(io_error)?;
    directory.write_tag(Tag::BitsPerSample, &[8u16, 8, 8, 8][..]).map_err(io_error)?;
    directory.write_tag(Tag::SamplesPerPixel, 4u16).map_err(io_error)?;
    directory.write_tag(Tag::PhotometricInterpretation, 2u16).map_err(io_error)?;
    directory.write_tag(Tag::Compression, match compression { TiffCompression::None => 1u16, TiffCompression::Lzw => 5, TiffCompression::Deflate => 8 }).map_err(io_error)?;
    directory.write_tag(Tag::PlanarConfiguration, 1u16).map_err(io_error)?;
    directory.write_tag(Tag::ExtraSamples, &[2u16][..]).map_err(io_error)?;
    directory.write_tag(Tag::RowsPerStrip, rows).map_err(io_error)?;
    directory.write_tag(Tag::StripOffsets, offsets.as_slice()).map_err(io_error)?;
    directory.write_tag(Tag::StripByteCounts, counts.as_slice()).map_err(io_error)?;
    let n = (1u32 << grid.zoom) as f64;
    let world = 2.0 * std::f64::consts::PI * 6_378_137.0;
    let resolution = world / (n * f64::from(tile_size));
    let scale = [resolution, resolution, 0.0];
    let tie = [0.0, 0.0, 0.0, (f64::from(grid.x_min) / n - 0.5) * world + f64::from(crop.left) * resolution,
        (0.5 - f64::from(grid.y_min) / n) * world - f64::from(crop.top) * resolution, 0.0];
    let keys = [1u16, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857];
    directory.write_tag(Tag::ModelPixelScaleTag, scale.as_slice()).map_err(io_error)?;
    directory.write_tag(Tag::ModelTiepointTag, tie.as_slice()).map_err(io_error)?;
    directory.write_tag(Tag::GeoKeyDirectoryTag, keys.as_slice()).map_err(io_error)?;
    directory.finish().map_err(io_error)?;
    if pyramid { append_overviews(&mut encoder, spool, grid, crop, tile_size, boundary, compression, &mut check)?; }
    drop(encoder);
    use std::io::Write;
    writer.flush().map_err(io_error)?;
    writer.get_ref().sync_all().map_err(io_error)?;
    Ok(preview)
}

fn append_overviews<W, F>(encoder: &mut TiffEncoder<W, tiff::encoder::TiffKindBig>, spool: &TileSpool,
    grid: &TileGrid, crop: &PixelCrop, tile_size: u16, boundary: Option<&BoundaryGeometry>, compression: TiffCompression, check: &mut F) -> Result<(), CoreError>
where W: std::io::Write + std::io::Seek, F: FnMut() -> Result<(), CoreError> {
    let mut factor = 2u32;
    while crop.width.div_ceil(factor) > 0 && crop.height.div_ceil(factor) > 0 && crop.width.max(crop.height).div_ceil(factor / 2) > 256 {
        let width = crop.width.div_ceil(factor);
        let height = crop.height.div_ceil(factor);
        let rows = (STRIP_BUDGET / (u64::from(width) * 4)).min(256).max(1) as u32;
        let mut directory = encoder.new_directory().map_err(io_error)?;
        let mut offsets = Vec::new();
        let mut counts = Vec::new();
        let size = u32::from(tile_size);
        for row in (0..height).step_by(rows as usize) {
            check()?;
            let strip_height = rows.min(height - row);
            let mut strip = RgbaImage::new(width, strip_height);
            let first_y = grid.y_min + (crop.top + row * factor) / size;
            let last_y = grid.y_min + (crop.top + ((row + strip_height - 1) * factor).min(crop.height - 1)) / size;
            for y in first_y..=last_y {
                for x in grid.x_min + crop.left / size..=grid.x_min + (crop.left + crop.width - 1) / size {
                    let left = (x - grid.x_min) * size;
                    let top = (y - grid.y_min) * size;
                    let x0 = left.saturating_sub(crop.left).div_ceil(factor);
                    let x1 = (left + size).saturating_sub(crop.left).div_ceil(factor).min(width);
                    let y0 = top.saturating_sub(crop.top).div_ceil(factor).max(row);
                    let y1 = (top + size).saturating_sub(crop.top).div_ceil(factor).min(row + strip_height);
                    if x0 >= x1 || y0 >= y1 { continue; }
                    let Some(path) = spool.paths.get(&(x,y)) else { continue; };
                    let mut tile = image::load_from_memory(&fs::read(path).map_err(io_error)?).map_err(io_error)?.to_rgba8();
                    if let Some(boundary) = boundary { mask_rgba(&mut tile, boundary, grid, tile_size, left, top); }
                    for py in y0..y1 { for px in x0..x1 {
                        strip.put_pixel(px, py - row, *tile.get_pixel(crop.left + px * factor - left, crop.top + py * factor - top));
                    } }
                }
            }
            let mut compressed = Vec::new();
            match compression {
                TiffCompression::Lzw => { Lzw.write_to(&mut compressed, strip.as_raw()).map_err(io_error)?; },
                TiffCompression::Deflate => { Deflate::default().write_to(&mut compressed, strip.as_raw()).map_err(io_error)?; },
                TiffCompression::None => compressed.extend_from_slice(strip.as_raw()),
            }
            offsets.push(directory.write_data(compressed.as_slice()).map_err(io_error)?);
            counts.push(compressed.len() as u64);
        }
        directory.write_tag(Tag::NewSubfileType, 1u32).map_err(io_error)?;
        directory.write_tag(Tag::ImageWidth, width).map_err(io_error)?;
        directory.write_tag(Tag::ImageLength, height).map_err(io_error)?;
        directory.write_tag(Tag::BitsPerSample, &[8u16,8,8,8][..]).map_err(io_error)?;
        directory.write_tag(Tag::SamplesPerPixel, 4u16).map_err(io_error)?;
        directory.write_tag(Tag::PhotometricInterpretation, 2u16).map_err(io_error)?;
        directory.write_tag(Tag::Compression, match compression { TiffCompression::None => 1u16, TiffCompression::Lzw => 5, TiffCompression::Deflate => 8 }).map_err(io_error)?;
        directory.write_tag(Tag::ExtraSamples, &[2u16][..]).map_err(io_error)?;
        directory.write_tag(Tag::RowsPerStrip, rows).map_err(io_error)?;
        directory.write_tag(Tag::StripOffsets, offsets.as_slice()).map_err(io_error)?;
        directory.write_tag(Tag::StripByteCounts, counts.as_slice()).map_err(io_error)?;
        directory.finish().map_err(io_error)?;
        factor = factor.checked_mul(2).ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Overview scale overflow"))?;
    }
    Ok(())
}

/// Terrarium RGB is an encoding of metres, never exported as three colour bands.
/// Polygon holes and unavailable pixels become GDAL NoData=-9999.
pub(super) fn write_dem<F>(path: &Path, spool: &TileSpool, grid: &TileGrid, crop: &PixelCrop, tile_size: u16,
    boundary: Option<&BoundaryGeometry>, compression: TiffCompression, pyramid: bool, mut check: F) -> Result<RgbaImage,CoreError>
where F: FnMut() -> Result<(),CoreError> {
    let mut writer = BufWriter::new(File::create(path).map_err(io_error)?);
    let mut encoder = TiffEncoder::new_big(&mut writer).map_err(io_error)?;
    let size = u32::from(tile_size);
    let world = 2.0*std::f64::consts::PI*6_378_137.0;
    let resolution = world / (1u32 << grid.zoom) as f64 / f64::from(tile_size);
    let mut preview = blank_preview(crop);
    let mut factor = 1u32;
    loop {
        let width = crop.width.div_ceil(factor);
        let height = crop.height.div_ceil(factor);
        if u64::from(width)*4 > STRIP_BUDGET { return Err(CoreError::new("RESOURCE_LIMIT", "Elevation strip is too wide")); }
        let rows = (STRIP_BUDGET/(u64::from(width)*4)).min(256).max(1) as u32;
        let mut directory = encoder.new_directory().map_err(io_error)?;
        let mut offsets=Vec::new(); let mut counts=Vec::new(); let mut preview_y=0;
        for row in (0..height).step_by(rows as usize) {
            check()?;
            let strip_height = rows.min(height-row);
            let mut values = vec![-9999f32; width as usize*strip_height as usize];
            let first_y=grid.y_min+(crop.top+row*factor)/size;
            let last_y=grid.y_min+(crop.top+((row+strip_height-1)*factor).min(crop.height-1))/size;
            for y in first_y..=last_y { for x in grid.x_min+crop.left/size..=grid.x_min+(crop.left+crop.width-1)/size {
                let Some(path)=spool.paths.get(&(x,y)) else {continue;};
                let left=(x-grid.x_min)*size; let top=(y-grid.y_min)*size;
                let x0=left.saturating_sub(crop.left).div_ceil(factor);
                let x1=(left+size).saturating_sub(crop.left).div_ceil(factor).min(width);
                let y0=top.saturating_sub(crop.top).div_ceil(factor).max(row);
                let y1=(top+size).saturating_sub(crop.top).div_ceil(factor).min(row+strip_height);
                let mut tile=image::load_from_memory(&fs::read(path).map_err(io_error)?).map_err(io_error)?.to_rgba8();
                if tile.dimensions()!=(size,size) {return Err(CoreError::new("INVALID_TILE","Elevation tile dimensions changed"));}
                if let Some(boundary)=boundary {mask_rgba(&mut tile,boundary,grid,tile_size,left,top);}
                for py in y0..y1 {for px in x0..x1 {
                    let p=tile.get_pixel(crop.left+px*factor-left,crop.top+py*factor-top).0;
                    if p[3]!=0 {values[(py-row) as usize*width as usize+px as usize]=f32::from(p[0])*256.0+f32::from(p[1])+f32::from(p[2])/256.0-32768.0;}
                }}
            }}
            if factor==1 {
                while preview_y<preview.height() {
                    let sy=(u64::from(preview_y)*u64::from(height)/u64::from(preview.height())) as u32;
                    if sy>=row+strip_height {break;}
                    for px in 0..preview.width() {
                        let sx=(u64::from(px)*u64::from(width)/u64::from(preview.width())) as u32;
                        let v=values[(sy-row) as usize*width as usize+sx as usize];
                        let c=((v+1000.0)/6000.0*255.0).clamp(0.0,255.0) as u8;
                        preview.put_pixel(px,preview_y,image::Rgba([c,c,c,if v== -9999.0 {0}else{255}]));
                    }
                    preview_y+=1;
                }
            }
            let raw:Vec<u8>=values.iter().flat_map(|v|v.to_le_bytes()).collect();
            let mut compressed=Vec::new();
            match compression {TiffCompression::None=>compressed=raw,
                TiffCompression::Lzw=>{Lzw.write_to(&mut compressed,&raw).map_err(io_error)?;},
                TiffCompression::Deflate=>{Deflate::default().write_to(&mut compressed,&raw).map_err(io_error)?;}}
            offsets.push(directory.write_data(compressed.as_slice()).map_err(io_error)?);counts.push(compressed.len() as u64);
        }
        if factor>1 {directory.write_tag(Tag::NewSubfileType,1u32).map_err(io_error)?;}
        directory.write_tag(Tag::ImageWidth,width).map_err(io_error)?;
        directory.write_tag(Tag::ImageLength,height).map_err(io_error)?;
        directory.write_tag(Tag::BitsPerSample,&[32u16][..]).map_err(io_error)?;
        directory.write_tag(Tag::SampleFormat,&[3u16][..]).map_err(io_error)?;
        directory.write_tag(Tag::SamplesPerPixel,1u16).map_err(io_error)?;
        directory.write_tag(Tag::PhotometricInterpretation,1u16).map_err(io_error)?;
        directory.write_tag(Tag::Compression,match compression {TiffCompression::None=>1u16,TiffCompression::Lzw=>5,TiffCompression::Deflate=>8}).map_err(io_error)?;
        directory.write_tag(Tag::RowsPerStrip,rows).map_err(io_error)?;
        directory.write_tag(Tag::StripOffsets,offsets.as_slice()).map_err(io_error)?;
        directory.write_tag(Tag::StripByteCounts,counts.as_slice()).map_err(io_error)?;
        directory.write_tag(Tag::Unknown(42113),"-9999").map_err(io_error)?;
        if factor==1 {
            directory.write_tag(Tag::ModelPixelScaleTag,&[resolution,resolution,0.0][..]).map_err(io_error)?;
            directory.write_tag(Tag::ModelTiepointTag,&[0.0,0.0,0.0,(f64::from(grid.x_min)/(1u32<<grid.zoom) as f64-0.5)*world+f64::from(crop.left)*resolution,
                (0.5-f64::from(grid.y_min)/(1u32<<grid.zoom) as f64)*world-f64::from(crop.top)*resolution,0.0][..]).map_err(io_error)?;
            directory.write_tag(Tag::GeoKeyDirectoryTag,&[1u16,1,0,3,1024,0,1,1,1025,0,1,1,3072,0,1,3857][..]).map_err(io_error)?;
        }
        directory.finish().map_err(io_error)?;
        if !pyramid || width.max(height)<=256 {break;}
        factor=factor.checked_mul(2).ok_or_else(||CoreError::new("RESOURCE_LIMIT","Elevation overview scale overflow"))?;
    }
    drop(encoder);
    use std::io::Write;
    check()?;writer.flush().map_err(io_error)?;writer.get_ref().sync_all().map_err(io_error)?;
    Ok(preview)
}

pub(super) fn write_png<F>(path: &Path, spool: &TileSpool, grid: &TileGrid, crop: &PixelCrop,
    tile_size: u16, boundary: Option<&BoundaryGeometry>, mut check: F) -> Result<RgbaImage, CoreError>
where F: FnMut() -> Result<(), CoreError> {
    let row_bytes = u64::from(crop.width) * 4;
    if row_bytes > STRIP_BUDGET { return Err(CoreError::new("RESOURCE_LIMIT", "Raster row exceeds the export buffer")); }
    let rows = (STRIP_BUDGET / row_bytes).min(u64::from(tile_size)).max(1) as u32;
    let mut preview = blank_preview(crop);
    let mut py = 0;
    let mut encoder = png::Encoder::new(BufWriter::new(File::create(path).map_err(io_error)?), crop.width, crop.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(io_error)?;
    let mut stream = writer.stream_writer().map_err(io_error)?;
    use std::io::Write;
    for row in (0..crop.height).step_by(rows as usize) {
        check()?;
        let height = rows.min(crop.height - row);
        let mut strip = spool.strip(grid, crop, tile_size, row, height)?;
        if let Some(boundary) = boundary { mask_rgba(&mut strip, boundary, grid, tile_size, crop.left, crop.top + row); }
        sample_preview(&strip, crop, row, &mut preview, &mut py);
        stream.write_all(strip.as_raw()).map_err(io_error)?;
    }
    check()?;
    stream.finish().map_err(io_error)?;
    writer.finish().map_err(io_error)?;
    Ok(preview)
}

fn blank_preview(crop: &PixelCrop) -> RgbaImage {
    let scale = (1024.0 / f64::from(crop.width.max(crop.height))).min(1.0);
    RgbaImage::new((f64::from(crop.width) * scale).round().max(1.0) as u32, (f64::from(crop.height) * scale).round().max(1.0) as u32)
}
fn sample_preview(strip: &RgbaImage, crop: &PixelCrop, row: u32, preview: &mut RgbaImage, py: &mut u32) {
    while *py < preview.height() {
        let sy = (u64::from(*py) * u64::from(crop.height) / u64::from(preview.height())) as u32;
        if sy >= row + strip.height() { break; }
        for px in 0..preview.width() {
            let sx = (u64::from(px) * u64::from(crop.width) / u64::from(preview.width())) as u32;
            preview.put_pixel(px, *py, *strip.get_pixel(sx, sy - row));
        }
        *py += 1;
    }
}

/// JPEG's MCU encoder reads a tile-backed image view instead of a full RGB mosaic.
pub(super) fn write_jpeg<F>(path: &Path, spool: &TileSpool, grid: &TileGrid, crop: &PixelCrop,
    tile_size: u16, boundary: Option<&BoundaryGeometry>, quality: u8, mut check: F) -> Result<RgbaImage, CoreError>
where F: FnMut() -> Result<(), CoreError> {
    use image::GenericImageView;
    use std::cell::RefCell;
    struct View<'a> { spool: &'a TileSpool, grid: &'a TileGrid, crop: &'a PixelCrop, size: u32,
        boundary: Option<&'a BoundaryGeometry>, row: RefCell<Option<u32>>, tiles: RefCell<HashMap<u32, RgbaImage>>, error: RefCell<Option<CoreError>> }
    impl GenericImageView for View<'_> {
        type Pixel = image::Rgb<u8>;
        fn dimensions(&self) -> (u32, u32) { (self.crop.width, self.crop.height) }
        fn get_pixel(&self, px: u32, py: u32) -> Self::Pixel {
            let sx = px + self.crop.left;
            let sy = py + self.crop.top;
            let x = self.grid.x_min + sx / self.size;
            let y = self.grid.y_min + sy / self.size;
            if *self.row.borrow() != Some(y) { self.tiles.borrow_mut().clear(); *self.row.borrow_mut() = Some(y); }
            let mut tiles = self.tiles.borrow_mut();
            if !tiles.contains_key(&x) {
                if let Some(path) = self.spool.paths.get(&(x, y)) {
                    let result = fs::read(path).map_err(io_error).and_then(|b| image::load_from_memory(&b).map_err(io_error));
                    match result {
                        Ok(tile) => {
                            let mut tile = tile.to_rgba8();
                            if let Some(boundary) = self.boundary { mask_rgba(&mut tile, boundary, self.grid, self.size as u16, (x - self.grid.x_min) * self.size, (y - self.grid.y_min) * self.size); }
                            tiles.insert(x, tile);
                        },
                        Err(error) => *self.error.borrow_mut() = Some(error),
                    }
                }
            }
            let Some(tile) = tiles.get(&x) else { return image::Rgb([255, 255, 255]); };
            let p = tile.get_pixel(sx % self.size, sy % self.size).0;
            let a = u32::from(p[3]);
            image::Rgb([((u32::from(p[0]) * a + 255 * (255 - a)) / 255) as u8,
                ((u32::from(p[1]) * a + 255 * (255 - a)) / 255) as u8, ((u32::from(p[2]) * a + 255 * (255 - a)) / 255) as u8])
        }
    }
    struct CheckedWriter<W, F> { writer: W, check: F }
    impl<W: std::io::Write, F: FnMut() -> Result<(), CoreError>> std::io::Write for CheckedWriter<W, F> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            (self.check)().map_err(|e| std::io::Error::other(e.message))?;
            self.writer.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> { self.writer.flush() }
    }
    if u64::from(crop.width) * u64::from(tile_size) * 4 > STRIP_BUDGET { return Err(CoreError::new("RESOURCE_LIMIT", "JPEG tile row exceeds the export buffer; split the region")); }
    let view = View { spool, grid, crop, size: u32::from(tile_size), boundary, row: RefCell::new(None), tiles: RefCell::new(HashMap::new()), error: RefCell::new(None) };
    let mut writer = CheckedWriter { writer: BufWriter::new(File::create(path).map_err(io_error)?), check: &mut check };
    let result = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality).encode_image(&view);
    use std::io::Write;
    let flush = writer.flush();
    drop(writer);
    check()?;
    result.map_err(io_error)?;
    flush.map_err(io_error)?;
    if let Some(error) = view.error.take() { return Err(error); }
    let mut preview = blank_preview(crop);
    for y in 0..preview.height() { for x in 0..preview.width() {
        let p = view.get_pixel((u64::from(x) * u64::from(crop.width) / u64::from(preview.width())) as u32,
            (u64::from(y) * u64::from(crop.height) / u64::from(preview.height())) as u32).0;
        preview.put_pixel(x, y, image::Rgba([p[0], p[1], p[2], 255]));
    } }
    if let Some(error) = view.error.take() { return Err(error); }
    Ok(preview)
}

pub(super) fn write_sidecars(path: &Path, grid: &TileGrid, crop: &PixelCrop, tile_size: u16) -> Result<Vec<PathBuf>, CoreError> {
    let world = 2.0 * std::f64::consts::PI * 6_378_137.0;
    let n = (1u32 << grid.zoom) as f64;
    let resolution = world / n / f64::from(tile_size);
    let x = (f64::from(grid.x_min) / n - 0.5) * world + (f64::from(crop.left) + 0.5) * resolution;
    let y = (0.5 - f64::from(grid.y_min) / n) * world - (f64::from(crop.top) + 0.5) * resolution;
    let extension = match path.extension().and_then(|s| s.to_str()) { Some("png") => "pgw", Some("jpg") => "jgw", _ => "tfw" };
    let world_path = path.with_extension(extension);
    let prj = path.with_extension("prj");
    fs::write(&world_path, format!("{resolution:.15}\n0\n0\n{:.15}\n{x:.15}\n{y:.15}\n", -resolution)).map_err(io_error)?;
    fs::write(&prj, "PROJCS[\"WGS 84 / Pseudo-Mercator\",GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Mercator_1SP\"],PARAMETER[\"central_meridian\",0],PARAMETER[\"scale_factor\",1],PARAMETER[\"false_easting\",0],PARAMETER[\"false_northing\",0],UNIT[\"metre\",1],AUTHORITY[\"EPSG\",\"3857\"]]").map_err(io_error)?;
    Ok(vec![world_path, prj])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "large-raster acceptance: run explicitly with --release --ignored"]
    fn streams_a_raster_larger_than_the_previous_full_mosaic_limit() {
        let directory = tempfile::tempdir().unwrap();
        let mut spool = TileSpool::new(directory.path()).unwrap();
        let tile_path = directory.path().join("input.png");
        RgbaImage::from_pixel(256, 256, image::Rgba([19, 71, 103, 255])).save(&tile_path).unwrap();
        // 16 columns × 129 rows, 516 MiB decoded, without a full-image allocation.
        let longitude = |edge: f64| edge / 256.0 * 360.0 - 180.0;
        let latitude = |edge: f64| (std::f64::consts::PI * (1.0 - 2.0 * edge / 256.0)).sinh().atan().to_degrees();
        let grid = TileGrid { zoom: 8, x_min: 120, y_min: 60, x_max: 135, y_max: 188,
            columns: 16, rows: 129, tile_count: 2064, pixel_width: 4096, pixel_height: 33024,
            actual_bounds: [longitude(120.0), latitude(189.0), longitude(136.0), latitude(60.0)] };
        for y in grid.y_min..=grid.y_max { for x in grid.x_min..=grid.x_max {
            spool.save(x, y, &[], Some(tile_path.clone())).unwrap();
        } }
        let crop = crop_pixels(grid.actual_bounds, &grid, 256);
        assert!(u64::from(crop.width) * u64::from(crop.height) * 4 > 512 * 1024 * 1024);
        let path = directory.path().join("large.tif");
        let mut checks = 0;
        let preview = write_streaming_tiff(&path, &spool, &grid, &crop, 256, None, TiffCompression::Lzw, false, || { checks += 1; Ok(()) }).unwrap();
        assert!(checks >= 129);
        assert!(preview.width() <= 1024 && preview.height() <= 1024);
        assert_eq!(preview.get_pixel(0, 0).0, [19, 71, 103, 255]);
        let header = fs::read(&path).unwrap();
        assert_eq!(&header[..4], b"II+\0");
        let mut decoder = Decoder::new(File::open(&path).unwrap()).unwrap();
        assert_eq!(decoder.dimensions().unwrap(), (crop.width, crop.height));
        assert_eq!(decoder.get_tag_u32(Tag::Compression).unwrap(), 5);
        let tiff::decoder::DecodingResult::U8(pixels) = decoder.read_chunk(0).unwrap() else { panic!("expected RGBA") };
        assert_eq!(&pixels[..4], &[19, 71, 103, 255]);
        assert!(pixels.len() as u64 <= STRIP_BUDGET);
        // Export cancellation is checked between strips rather than waiting for
        // completion of a whole large raster.
        let mut checks = 0;
        let error = write_streaming_tiff(&directory.path().join("cancel.tif"), &spool, &grid, &crop, 256, None, TiffCompression::Lzw, false, || {
            checks += 1;
            if checks > 1 { Err(CoreError::new("CANCELLED", "test cancel")) } else { Ok(()) }
        }).unwrap_err();
        assert_eq!(error.code, "CANCELLED");
    }
}
