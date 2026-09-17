//! Figure handling: raster image extraction (DCT passthrough, Flate→PNG,
//! SMask alpha) and vector-figure clustering → SVG.

use crate::content::{ImageSource, InlineImage, PageItems, Path, PathSeg};
use crate::geom::Rect;
use crate::layout::Line;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

pub struct ExtractedFigure {
    /// Bounding box on the page.
    pub bbox: Rect,
    /// Relative path of the written asset.
    pub asset: String,
    /// true when produced from vector paths (svg), false for raster.
    pub is_svg: bool,
}

pub struct AssetSink<'a> {
    pub dir: &'a std::path::Path,
    counter: u32,
    page_no: u32,
}

impl<'a> AssetSink<'a> {
    pub fn new(dir: &'a std::path::Path, page_no: u32) -> Self {
        AssetSink { dir, counter: 0, page_no }
    }

    fn next_name(&mut self, ext: &str) -> (String, std::path::PathBuf) {
        self.counter += 1;
        let name = format!("p{}-fig{}.{}", self.page_no, self.counter, ext);
        let path = self.dir.join(&name);
        (name, path)
    }
}

/// Detects figures (raster + vector) on a page and writes their assets.
/// `used_glyphs` marks glyphs already consumed by tables (excluded).
pub fn extract_figures(
    doc: &lopdf::Document,
    items: &PageItems,
    lines: &[Line],
    body_size: f64,
    sink: &mut AssetSink,
) -> Vec<ExtractedFigure> {
    let mut figures: Vec<ExtractedFigure> = Vec::new();

    // ---- cluster images and paths by bbox proximity (union-find) ----
    let mut boxes: Vec<(Rect, bool)> = Vec::new(); // bool: is_image
    for img in &items.images {
        if img.bbox.width() >= 2.0 && img.bbox.height() >= 2.0 {
            boxes.push((img.bbox, true));
        }
    }
    for p in &items.paths {
        if !p.fill && !p.stroke {
            continue;
        }
        // ignore huge background rects (page-filling panels)
        if p.bbox.width() > items.page_width * 0.98 && p.bbox.height() > items.page_height * 0.95 {
            continue;
        }
        boxes.push((p.bbox, false));
    }
    let n = boxes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        if p[i] != i {
            let r = find(p, p[i]);
            p[i] = r;
        }
        p[i]
    }
    let gap_limit = 12.0;
    for i in 0..n {
        for j in (i + 1)..n {
            let (bi, bj) = (boxes[i].0, boxes[j].0);
            let gap = (bi.x0 - bj.x1)
                .max(bj.x0 - bi.x1)
                .max(bi.y0 - bj.y1)
                .max(bj.y0 - bi.y1);
            let overlap = bi.intersect_area(&bj) > 0.0;
            if overlap || gap < gap_limit {
                let a = find(&mut parent, i);
                let b = find(&mut parent, j);
                if a != b {
                    parent[a] = b;
                }
            }
        }
    }
    let mut clusters: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        clusters.entry(r).or_default().push(i);
    }

    for (_, members) in clusters {
        let mut bbox = Rect::empty();
        let mut has_image = false;
        let mut path_count = 0;
        for &m in &members {
            bbox.union(&boxes[m].0);
            if boxes[m].1 {
                has_image = true;
            } else {
                path_count += 1;
            }
        }
        if bbox.is_empty() {
            continue;
        }
        // figure plausibility: decent size and enough content
        let min_side = 18.0;
        if bbox.width() < min_side || bbox.height() < min_side {
            continue;
        }
        if !has_image && path_count < 3 {
            continue;
        }
        // Rule lines crossing text lines are tables/math, not figures: a
        // cluster whose box is "flat" (height < line height) over text is
        // decoration; skip those.
        if bbox.height() < body_size * 1.4 {
            // underline-like
            let touches_text = lines.iter().any(|l| {
                l.bbox().intersect_area(&bbox) > 0.3 * bbox.height() * bbox.width().max(1.0)
            });
            if touches_text {
                continue;
            }
        }
        let (name, path) = sink.next_name("svg");
        let page_no = sink.page_no;
        match write_figure_svg(doc, items, lines, body_size, &bbox, &path, &name, page_no) {
            Ok(()) => figures.push(ExtractedFigure { bbox, asset: name, is_svg: true }),
            Err(e) => {
                eprintln!("svg figure failed: {}", e);
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    figures
}

/// Writes one figure region as SVG (vector ops + embedded images + labels).
fn write_figure_svg(
    doc: &lopdf::Document,
    items: &PageItems,
    lines: &[Line],
    body_size: f64,
    bbox: &Rect,
    path: &std::path::Path,
    name: &str,
    page_no: u32,
) -> Result<(), String> {
    let w = bbox.width().max(1.0);
    let h = bbox.height().max(1.0);
    let mut svg = String::new();
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 {:.1} {:.1}\" width=\"{:.0}\" height=\"{:.0}\">\n",
        w, h, w * 2.0, h * 2.0
    ));
    svg.push_str(&format!(
        "<g transform=\"translate({:.2},{:.2})\">\n",
        -bbox.x0, -bbox.y0
    ));

    // images inside the cluster
    for (idx, img) in items.images.iter().enumerate() {
        if !bbox.contains_rect(&img.bbox) {
            continue;
        }
        let dir = path.parent().unwrap_or(std::path::Path::new("."));
        let seq = page_no * 1000 + idx as u32 + 1;
        let src = match &img.source {
            ImageSource::XObject(rid) => raster_to_file(doc, *rid, dir, seq)?,
            ImageSource::Inline(inline) => inline_to_file(inline, dir, seq),
        };
        if let Some(href) = src {
            svg.push_str(&format!(
                "<image x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" xlink:href=\"{}\" preserveAspectRatio=\"none\"/>\n",
                img.bbox.x0, img.bbox.y0, img.bbox.width(), img.bbox.height(), href
            ));
        }
    }

    // paths inside
    for p in &items.paths {
        if !bbox.contains_rect(&p.bbox) {
            continue;
        }
        svg.push_str(&path_to_svg(p));
    }

    // small text labels inside the figure
    for l in lines {
        if l.size >= body_size * 0.95 {
            continue;
        }
        let lb = l.bbox();
        if lb.x0 >= bbox.x0 - 2.0 && lb.x1 <= bbox.x1 + 2.0 && lb.y0 >= bbox.y0 - 2.0 && lb.y1 <= bbox.y1 + 2.0 {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" font-family=\"sans-serif\" font-size=\"{:.1}\">{}</text>\n",
                l.x0,
                l.baseline,
                l.size,
                xml_escape(&l.text())
            ));
        }
    }

    svg.push_str("</g>\n</svg>\n");
    std::fs::write(path, svg).map_err(|e| e.to_string())?;
    let _ = name;
    Ok(())
}

fn path_to_svg(p: &Path) -> String {
    let mut d = String::new();
    for seg in &p.segs {
        match seg {
            PathSeg::Move(x, y) => d.push_str(&format!("M{:.2} {:.2} ", x, y)),
            PathSeg::Line(x, y) => d.push_str(&format!("L{:.2} {:.2} ", x, y)),
            PathSeg::Curve(c1, c2, end) => match (c1, c2) {
                (Some((x1, y1)), _) => {
                    d.push_str(&format!("C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} ", x1, y1, c2.0, c2.1, end.0, end.1))
                }
                (None, _) => {
                    // v-style: first control = current point (unknown here) — approximate with end
                    d.push_str(&format!("S{:.2} {:.2} {:.2} {:.2} ", c2.0, c2.1, end.0, end.1))
                }
            },
            PathSeg::Close => d.push('Z'),
        }
    }
    let fc = color_hex(p.fill_color);
    let sc = color_hex(p.stroke_color);
    let mut attrs = String::new();
    if p.fill {
        attrs.push_str(&format!("fill=\"{}\"", fc));
    } else {
        attrs.push_str("fill=\"none\"");
    }
    if p.stroke {
        attrs.push_str(&format!(" stroke=\"{}\" stroke-width=\"{:.2}\"", sc, p.line_width.max(0.2)));
    }
    format!("<path d=\"{}\" {}/>\n", d.trim(), attrs)
}

fn color_hex(c: (f64, f64, f64)) -> String {
    let (r, g, b) = (
        (c.0.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.1.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.2.clamp(0.0, 1.0) * 255.0).round() as u8,
    );
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// --------------------------------------------------------------------------
// Raster extraction
// --------------------------------------------------------------------------

/// Decodes an image XObject and writes it as .jpg/.png next to the SVG.
/// Returns the file name to reference (relative), or None if unsupported.
pub fn raster_to_file(
    doc: &lopdf::Document,
    rid: lopdf::ObjectId,
    dir: &std::path::Path,
    seq: u32,
) -> Result<Option<String>, String> {
    let obj = doc.get_object(rid).map_err(|e| e.to_string())?;
    let stream = match obj {
        lopdf::Object::Stream(s) => s.clone(),
        _ => return Ok(None),
    };
    let dict = &stream.dict;
    let width = dict.get(b"Width").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let height = dict.get(b"Height").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let filters = stream_filters(&stream);
    let data = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());

    // DCT: write jpeg as-is
    if filters.iter().any(|f| f == "DCTDecode") {
        let name = format!("p-img-{}.jpg", seq);
        std::fs::write(dir.join(&name), &data).map_err(|e| e.to_string())?;
        return Ok(Some(name));
    }
    if filters.iter().any(|f| f == "JPXDecode" || f == "CCITTFaxDecode" || f == "JBIG2Decode") {
        return Ok(None); // unsupported without extra codecs
    }

    let bpc = dict.get(b"BitsPerComponent").and_then(|o| o.as_i64()).unwrap_or(8) as u32;
    let cs = color_space_components(dict, doc);
    let (pixels, channels) = match decode_samples(&data, width, height, bpc, cs.0) {
        Some(v) => v,
        None => return Ok(None),
    };
    // SMask → alpha
    let mut rgba: Option<Vec<u8>> = None;
    if let Ok(Ok(smask_id)) = dict.get(b"SMask").map(|o| o.as_reference()) {
        if let Some(alpha) = decode_smask(doc, smask_id, width, height) {
            let mut with_a = Vec::with_capacity((width * height * 4) as usize);
            for i in 0..(width * height) as usize {
                let px = i * channels;
                with_a.extend_from_slice(&pixels[px..px + channels.min(3)]);
                if channels == 4 {
                    // cmyk already converted to rgb; recompute below
                }
                with_a.push(alpha[i.min(alpha.len() - 1)]);
            }
            rgba = Some(with_a);
        }
    }
    let name = format!("p-img-{}.png", seq);
    let ok = if let Some(rgba) = rgba {
        write_png(dir.join(&name), width, height, 4, &rgba).is_ok()
    } else {
        match channels {
        1 => write_png(dir.join(&name), width, height, 1, &pixels).is_ok(),
        3 => write_png(dir.join(&name), width, height, 3, &pixels).is_ok(),
        4 => {
            // CMYK → RGB
            let mut rgb = Vec::with_capacity((width * height * 3) as usize);
            for px in pixels.chunks(4) {
                let (c, m, y, k) = (px[0], px[1], px[2], px.get(3).copied().unwrap_or(0));
                rgb.push((255 - c.min(255)).min(255 - k.min(255)));
                rgb.push((255 - m.min(255)).min(255 - k.min(255)));
                rgb.push((255 - y.min(255)).min(255 - k.min(255)));
            }
            write_png(dir.join(&name), width, height, 3, &rgb).is_ok()
        }
        _ => false,
        }
    };
    if ok {
        Ok(Some(name))
    } else {
        Ok(None)
    }
}

fn stream_filters(stream: &lopdf::Stream) -> Vec<String> {
    match stream.dict.get(b"Filter") {
        Ok(lopdf::Object::Name(n)) => vec![String::from_utf8_lossy(n).to_string()],
        Ok(lopdf::Object::Array(a)) => a
            .iter()
            .filter_map(|o| match o {
                lopdf::Object::Name(n) => Some(String::from_utf8_lossy(n).to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Returns (components, is_indexed, palette) for the color space.
fn color_space_components(dict: &lopdf::Dictionary, doc: &lopdf::Document) -> (usize, Option<Vec<u8>>) {
    match dict.get(b"ColorSpace") {
        Ok(lopdf::Object::Name(n)) => match n.as_slice() {
            b"DeviceGray" | b"G" => (1, None),
            b"DeviceRGB" | b"RGB" => (3, None),
            b"DeviceCMYK" | b"CMYK" => (4, None),
            _ => (1, None),
        },
        Ok(lopdf::Object::Array(a)) => {
            let family = a.first().and_then(|o| match o {
                lopdf::Object::Name(n) => Some(n.clone()),
                _ => None,
            });
            match family.as_deref() {
                Some(b"ICBased") => {
                    let n = dict_n_of(&a[1], doc).unwrap_or(3);
                    (n as usize, None)
                }
                Some(b"Indexed") => {
                    // [/Indexed base hival lookup]
                    let lookup = a.get(3).cloned();
                    let palette = match lookup {
                        Some(lopdf::Object::Stream(s)) => s
                            .decompressed_content()
                            .unwrap_or_else(|_| s.content.clone()),
                        Some(lopdf::Object::String(bytes, _)) => bytes.clone(),
                        Some(lopdf::Object::Reference(rid)) => match doc.get_object(rid).ok() {
                            Some(lopdf::Object::Stream(s)) => s
                                .decompressed_content()
                                .unwrap_or_else(|_| s.content.clone()),
                            _ => Vec::new(),
                        },
                        _ => Vec::new(),
                    };
                    (1, Some(palette))
                }
                _ => (3, None),
            }
        }
        _ => (1, None),
    }
}

fn dict_n_of(o: &lopdf::Object, doc: &lopdf::Document) -> Option<i64> {
    match o {
        lopdf::Object::Reference(rid) => doc
            .get_object(*rid)
            .ok()
            .and_then(|obj| obj.as_dict().ok())
            .and_then(|d| d.get(b"N").and_then(|x| x.as_i64()).ok()),
        lopdf::Object::Dictionary(d) => d.get(b"N").and_then(|x| x.as_i64()).ok(),
        _ => None,
    }
}

/// Expands raw samples to 8-bit channels; handles indexed palettes.
fn decode_samples(
    data: &[u8],
    width: u32,
    height: u32,
    bpc: u32,
    channels: usize,
) -> Option<(Vec<u8>, usize)> {
    let expected = (width as usize) * (height as usize);
    if bpc == 8 {
        if data.len() < expected * channels {
            return None;
        }
        let mut out = Vec::with_capacity(expected * channels);
        out.extend_from_slice(&data[..expected * channels]);
        Some((out, channels))
    } else if bpc == 1 && channels == 1 {
        let row_bytes = ((width as usize) + 7) / 8;
        if data.len() < row_bytes * height as usize {
            return None;
        }
        let mut out = Vec::with_capacity(expected);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let byte = data[y * row_bytes + x / 8];
                let bit = (byte >> (7 - (x % 8))) & 1;
                out.push(if bit == 0 { 0 } else { 255 });
            }
        }
        Some((out, 1))
    } else {
        None
    }
}

fn decode_smask(doc: &lopdf::Document, rid: lopdf::ObjectId, width: u32, height: u32) -> Option<Vec<u8>> {
    let obj = doc.get_object(rid).ok()?;
    let stream = match obj {
        lopdf::Object::Stream(s) => s.clone(),
        _ => return None,
    };
    let sw = stream.dict.get(b"Width").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let sh = stream.dict.get(b"Height").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let bpc = stream.dict.get(b"BitsPerComponent").and_then(|o| o.as_i64()).unwrap_or(8) as u32;
    let data = stream.decompressed_content().ok()?;
    if sw == 0 || sh == 0 {
        return None;
    }
    let (pixels, _) = decode_samples(&data, sw, sh, bpc, 1)?;
    // resample to target size (nearest)
    let mut out = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        let sy = (y * sh / height.max(1)) as usize;
        for x in 0..width {
            let sx = (x * sw / width.max(1)) as usize;
            out.push(pixels[sy * sw as usize + sx]);
        }
    }
    Some(out)
}

// --------------------------------------------------------------------------
// PNG writer (no external image crate)
// --------------------------------------------------------------------------

pub fn write_png(path: std::path::PathBuf, width: u32, height: u32, channels: u32, pixels: &[u8]) -> Result<(), String> {
    if width == 0 || height == 0 || channels == 0 || channels > 4 {
        return Err("bad dims".into());
    }
    let expected = (width as usize) * (height as usize) * (channels as usize);
    if pixels.len() < expected {
        return Err(format!("png: need {} bytes, got {}", expected, pixels.len()));
    }
    // raw scanlines with filter byte 0
    let stride = width as usize * channels as usize;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0u8);
        raw.extend_from_slice(&pixels[y * stride..(y + 1) * stride]);
    }
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw).map_err(|e| e.to_string())?;
    let idat = enc.finish().map_err(|e| e.to_string())?;

    let color_type: u8 = match channels {
        1 => 0,
        3 => 2,
        4 => 6,
        _ => return Err("bad channels".into()),
    };
    let mut png = Vec::with_capacity(idat.len() + 128);
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &idat);
    write_chunk(&mut png, b"IEND", &[]);
    std::fs::write(path, png).map_err(|e| e.to_string())
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, e) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// Inline images (BI..EI): decode like XObject images.
pub fn inline_to_file(img: &InlineImage, dir: &std::path::Path, seq: u32) -> Option<String> {
    let channels = match img.color_space.as_str() {
        "G" | "DeviceGray" | "CalGray" => 1,
        "RGB" | "DeviceRGB" | "CalRGB" => 3,
        "CMYK" | "DeviceCMYK" => 4,
        _ => 1,
    };
    let data = if img.filter.contains("Fl") {
        inflate(&img.data).ok()?
    } else {
        img.data.clone()
    };
    let (pixels, channels) = decode_samples(&data, img.width, img.height, img.bits, channels)?;
    let name = format!("p-inline-{}.png", seq);
    if write_png(dir.join(&name), img.width, img.height, channels as u32, &pixels).is_ok() {
        Some(name)
    } else {
        None
    }
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    std::io::Read::read_to_end(&mut decoder, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
