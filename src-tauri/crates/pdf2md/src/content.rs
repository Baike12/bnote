//! PDF content-stream interpreter: turns operators into device-space glyphs,
//! rules, paths and image placements. Coordinates are flipped to top-left
//! origin (y grows downward) so all downstream layout code thinks in text
//! coordinates.

use crate::font::{load_font, FontInfo, TexKind};
use crate::geom::{Mat, Rect};
use lopdf::{Document, Object};
use std::collections::HashMap;

/// A placed text glyph in device space.
#[derive(Debug, Clone)]
pub struct Glyph {
    /// Baseline origin (device pt, y down).
    pub x: f64,
    pub y: f64,
    /// Advance width (device pt).
    pub wx: f64,
    /// Font size (device pt).
    pub size: f64,
    /// Raw code (CID).
    pub code: u32,
    /// Resolved unicode text (may be empty for unmapped glyphs).
    pub text: String,
    /// Direct LaTeX for math fonts.
    pub latex: Option<String>,
    /// Index into the page's font table.
    pub font: usize,
}

impl Glyph {
    /// Bounding box approximation (baseline ± typical ascent/descent).
    pub fn bbox(&self) -> Rect {
        Rect {
            x0: self.x,
            y0: self.y - self.size * 0.78,
            x1: self.x + self.wx,
            y1: self.y + self.size * 0.24,
        }
    }
}

/// Thin axis-aligned rule (fraction bars, table lines, underlines).
#[derive(Debug, Clone)]
pub struct Rule {
    pub rect: Rect,
    pub color: (f64, f64, f64),
}

#[derive(Debug, Clone)]
pub enum PathSeg {
    Move(f64, f64),
    Line(f64, f64),
    Curve(Option<(f64, f64)>, (f64, f64), (f64, f64)),
    Close,
}

/// A painted path, coordinates already in device space.
#[derive(Debug, Clone)]
pub struct Path {
    pub segs: Vec<PathSeg>,
    pub fill: bool,
    pub stroke: bool,
    pub line_width: f64,
    pub fill_color: (f64, f64, f64),
    pub stroke_color: (f64, f64, f64),
    pub bbox: Rect,
}

/// An image placement.
#[derive(Debug, Clone)]
pub struct Image {
    pub bbox: Rect,
    pub source: ImageSource,
}

#[derive(Debug, Clone)]
pub enum ImageSource {
    XObject(lopdf::ObjectId),
    Inline(InlineImage),
}

#[derive(Debug, Clone)]
pub struct InlineImage {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bits: u32,
    pub color_space: String,
    pub filter: String,
}

/// Everything extracted from one page, in device coordinates.
#[derive(Debug, Default)]
pub struct PageItems {
    pub glyphs: Vec<Glyph>,
    pub rules: Vec<Rule>,
    pub paths: Vec<Path>,
    pub images: Vec<Image>,
    pub page_width: f64,
    pub page_height: f64,
    pub fonts: Vec<FontInfo>,
}

#[derive(Clone)]
struct GState {
    ctm: Mat,
    fill_color: (f64, f64, f64),
    stroke_color: (f64, f64, f64),
    line_width: f64,
    clip: Rect,
}

struct TextState {
    font: Option<usize>,
    size: f64,
    char_spacing: f64,
    word_spacing: f64,
    h_scale: f64,
    rise: f64,
    leading: f64,
    tm: Mat,
    tlm: Mat,
    rendering: u8,
}

impl TextState {
    fn new() -> TextState {
        TextState {
            font: None,
            size: 12.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            h_scale: 1.0,
            rise: 0.0,
            leading: 0.0,
            tm: Mat::IDENTITY,
            tlm: Mat::IDENTITY,
            rendering: 0,
        }
    }
}

struct PathState {
    segs: Vec<PathSeg>,
    bbox: Rect,
    /// Set when the whole path is exactly one axis-aligned `re`.
    single_rect: bool,
    clip_pending: bool,
}

impl PathState {
    fn new() -> PathState {
        PathState { segs: Vec::new(), bbox: Rect::empty(), single_rect: false, clip_pending: false }
    }
}

pub struct Interp<'a> {
    doc: &'a Document,
    font_cache: &'a mut HashMap<lopdf::ObjectId, FontInfo>,
    /// Dedupes font entries per page: object id → index in items.fonts.
    font_ids: HashMap<lopdf::ObjectId, usize>,
    items: PageItems,
}

impl<'a> Interp<'a> {
    pub fn new(doc: &'a Document, font_cache: &'a mut HashMap<lopdf::ObjectId, FontInfo>) -> Self {
        Interp {
            doc,
            font_cache,
            font_ids: HashMap::new(),
            items: PageItems::default(),
        }
    }

    /// Interprets one page.
    pub fn run_page(mut self, page_id: lopdf::ObjectId) -> Result<PageItems, String> {
        let (media, resources) = page_attrs(self.doc, page_id);
        let (w, h) = media
            .map(|r| (r.width(), r.height()))
            .unwrap_or((612.0, 792.0));
        self.items.page_width = w;
        self.items.page_height = h;

        let content = page_content_bytes(self.doc, page_id)?;
        let gs0 = GState {
            ctm: Mat { a: 1.0, b: 0.0, c: 0.0, d: -1.0, e: 0.0, f: h },
            fill_color: (0.0, 0.0, 0.0),
            stroke_color: (0.0, 0.0, 0.0),
            line_width: 1.0,
            clip: Rect { x0: 0.0, y0: 0.0, x1: w, y1: h },
        };
        let mut ctx = RunCtx {
            stack: vec![gs0],
            ts: TextState::new(),
            path: PathState::new(),
            resources,
        };
        self.run(&content, &mut ctx);
        Ok(std::mem::take(&mut self.items))
    }

    /// Executes a content stream in the given context (recursive for forms).
    fn run(&mut self, content: &[u8], ctx: &mut RunCtx) {
        let mut p = Parser::new(content);
        let mut operands: Vec<Op> = Vec::new();
        while let Some(tok) = p.next_token() {
            match tok {
                Token::Operand(o) => operands.push(o),
                Token::Op(name) => self.exec(&name, &mut operands, ctx),
            }
        }
    }

    fn exec(&mut self, name: &str, ops: &mut Vec<Op>, ctx: &mut RunCtx) {
        let num = |o: &[Op], i: usize| o.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
        let gs = match ctx.stack.last() {
            Some(g) => g.clone(),
            None => return,
        };

        match name {
            "q" => {
                let g = ctx.stack.last().cloned();
                if let Some(g) = g {
                    ctx.stack.push(g);
                }
            }
            "Q" => {
                if ctx.stack.len() > 1 {
                    ctx.stack.pop();
                }
            }
            "cm" if ops.len() >= 6 => {
                let m = Mat {
                    a: num(ops, 0),
                    b: num(ops, 1),
                    c: num(ops, 2),
                    d: num(ops, 3),
                    e: num(ops, 4),
                    f: num(ops, 5),
                };
                if let Some(g) = ctx.stack.last_mut() {
                    g.ctm = m.mul(&g.ctm);
                }
            }
            "w" => {
                if let Some(g) = ctx.stack.last_mut() {
                    g.line_width = num(ops, 0).max(0.0);
                }
            }
            "g" => set_fill(ctx, num(ops, 0), num(ops, 0), num(ops, 0)),
            "G" => set_stroke(ctx, num(ops, 0), num(ops, 0), num(ops, 0)),
            "rg" => set_fill(ctx, num(ops, 0), num(ops, 1), num(ops, 2)),
            "RG" => set_stroke(ctx, num(ops, 0), num(ops, 1), num(ops, 2)),
            "k" => {
                let c = cmyk(ops);
                if let Some(g) = ctx.stack.last_mut() {
                    g.fill_color = c;
                }
            }
            "K" => {
                let c = cmyk(ops);
                if let Some(g) = ctx.stack.last_mut() {
                    g.stroke_color = c;
                }
            }
            "sc" | "scn" => match ops.len() {
                1 => set_fill(ctx, num(ops, 0), num(ops, 0), num(ops, 0)),
                3 => set_fill(ctx, num(ops, 0), num(ops, 1), num(ops, 2)),
                4 => {
                    let c = cmyk(ops);
                    if let Some(g) = ctx.stack.last_mut() {
                        g.fill_color = c;
                    }
                }
                _ => {}
            },
            "SC" | "SCN" => match ops.len() {
                1 => set_stroke(ctx, num(ops, 0), num(ops, 0), num(ops, 0)),
                3 => set_stroke(ctx, num(ops, 0), num(ops, 1), num(ops, 2)),
                4 => {
                    let c = cmyk(ops);
                    if let Some(g) = ctx.stack.last_mut() {
                        g.stroke_color = c;
                    }
                }
                _ => {}
            },

            // ---------------- text state ----------------
            "Tf" => {
                ctx.ts.size = num(ops, 1);
                if let Some(rname) = ops.first().and_then(|o| o.as_name()) {
                    ctx.ts.font = self.resolve_font(&ctx.resources, &rname);
                }
            }
            "Tc" => ctx.ts.char_spacing = num(ops, 0),
            "Tw" => ctx.ts.word_spacing = num(ops, 0),
            "Tz" => ctx.ts.h_scale = num(ops, 0) / 100.0,
            "TL" => ctx.ts.leading = num(ops, 0),
            "Ts" => ctx.ts.rise = num(ops, 0),
            "Tr" => ctx.ts.rendering = num(ops, 0) as u8,

            "BT" => {
                ctx.ts.tm = Mat::IDENTITY;
                ctx.ts.tlm = Mat::IDENTITY;
            }
            "Td" => {
                ctx.ts.tlm =
                    translate(num(ops, 0), num(ops, 1)).mul(&ctx.ts.tlm);
                ctx.ts.tm = ctx.ts.tlm;
            }
            "TD" => {
                ctx.ts.leading = -num(ops, 1);
                ctx.ts.tlm =
                    translate(num(ops, 0), num(ops, 1)).mul(&ctx.ts.tlm);
                ctx.ts.tm = ctx.ts.tlm;
            }
            "Tm" => {
                let m = Mat {
                    a: num(ops, 0),
                    b: num(ops, 1),
                    c: num(ops, 2),
                    d: num(ops, 3),
                    e: num(ops, 4),
                    f: num(ops, 5),
                };
                ctx.ts.tm = m;
                ctx.ts.tlm = m;
            }
            "T*" => {
                ctx.ts.tlm = translate(0.0, -ctx.ts.leading).mul(&ctx.ts.tlm);
                ctx.ts.tm = ctx.ts.tlm;
            }

            // ---------------- text painting ----------------
            "Tj" | "'" | "\"" => {
                if name == "'" || name == "\"" {
                    ctx.ts.tlm = translate(0.0, -ctx.ts.leading).mul(&ctx.ts.tlm);
                    ctx.ts.tm = ctx.ts.tlm;
                }
                if name == "\"" {
                    ctx.ts.word_spacing = num(ops, 0);
                    ctx.ts.char_spacing = num(ops, 1);
                }
                let idx = if name == "\"" { 3 } else { 1 };
                if let Some(Op::String(bytes)) = ops.get(ops.len().wrapping_sub(idx)).cloned() {
                    self.show_string(&bytes, &gs, &mut ctx.ts);
                }
            }
            "TJ" => {
                if let Some(Op::Array(elems)) = ops.last() {
                    for el in elems {
                        match el {
                            Op::String(bytes) => {
                                let b = bytes.clone();
                                self.show_string(&b, &gs, &mut ctx.ts);
                            }
                            Op::Num(k) => {
                                let tx = -*k / 1000.0 * ctx.ts.size * ctx.ts.h_scale;
                                ctx.ts.tm = translate(tx, 0.0).mul(&ctx.ts.tm);
                            }
                            _ => {}
                        }
                    }
                }
            }

            // ---------------- paths ----------------
            "m" => {
                ctx.path.segs.clear();
                ctx.path.bbox = Rect::empty();
                ctx.path.single_rect = false;
                let (x, y) = gs.ctm.apply(num(ops, 0), num(ops, 1));
                ctx.path.segs.push(PathSeg::Move(x, y));
                ctx.path.bbox.add(x, y);
            }
            "l" => {
                let (x, y) = gs.ctm.apply(num(ops, 0), num(ops, 1));
                ctx.path.segs.push(PathSeg::Line(x, y));
                ctx.path.bbox.add(x, y);
            }
            "c" => {
                let p1 = gs.ctm.apply(num(ops, 0), num(ops, 1));
                let p2 = gs.ctm.apply(num(ops, 2), num(ops, 3));
                let p3 = gs.ctm.apply(num(ops, 4), num(ops, 5));
                ctx.path.segs.push(PathSeg::Curve(Some(p1), p2, p3));
                for (x, y) in [p1, p2, p3] {
                    ctx.path.bbox.add(x, y);
                }
            }
            "v" => {
                let p2 = gs.ctm.apply(num(ops, 0), num(ops, 1));
                let p3 = gs.ctm.apply(num(ops, 2), num(ops, 3));
                ctx.path.segs.push(PathSeg::Curve(None, p2, p3));
                for (x, y) in [p2, p3] {
                    ctx.path.bbox.add(x, y);
                }
            }
            "y" => {
                let p1 = gs.ctm.apply(num(ops, 0), num(ops, 1));
                let p3 = gs.ctm.apply(num(ops, 2), num(ops, 3));
                ctx.path.segs.push(PathSeg::Curve(Some(p1), (f64::NAN, f64::NAN), p3));
                for (x, y) in [p1, p3] {
                    ctx.path.bbox.add(x, y);
                }
            }
            "h" => ctx.path.segs.push(PathSeg::Close),
            "re" => {
                ctx.path.segs.clear();
                ctx.path.bbox = Rect::empty();
                let (x1, y1) = gs.ctm.apply(num(ops, 0), num(ops, 1));
                let (x2, y2) =
                    gs.ctm.apply(num(ops, 0) + num(ops, 2), num(ops, 1) + num(ops, 3));
                let rect = Rect {
                    x0: x1.min(x2),
                    y0: y1.min(y2),
                    x1: x1.max(x2),
                    y1: y1.max(y2),
                };
                let axis = gs.ctm.b.abs() < 1e-6 && gs.ctm.c.abs() < 1e-6;
                ctx.path.segs.push(PathSeg::Move(rect.x0, rect.y0));
                ctx.path.segs.push(PathSeg::Line(rect.x1, rect.y0));
                ctx.path.segs.push(PathSeg::Line(rect.x1, rect.y1));
                ctx.path.segs.push(PathSeg::Line(rect.x0, rect.y1));
                ctx.path.segs.push(PathSeg::Close);
                ctx.path.bbox = rect;
                ctx.path.single_rect = axis;
            }

            "W" | "W*" => ctx.path.clip_pending = true,

            "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "s" | "S" | "n" => {
                let fill = matches!(name, "f" | "F" | "f*" | "B" | "B*" | "b" | "b*");
                let stroke = matches!(name, "S" | "s" | "B" | "B*" | "b" | "b*");
                let bbox = ctx.path.bbox;
                let single = ctx.path.single_rect;

                // Clip handling first (W n is the standard clip idiom).
                if ctx.path.clip_pending {
                    let inter = Rect {
                        x0: bbox.x0.max(gs.clip.x0),
                        y0: bbox.y0.max(gs.clip.y0),
                        x1: bbox.x1.min(gs.clip.x1),
                        y1: bbox.y1.min(gs.clip.y1),
                    };
                    if !inter.is_empty() && name == "n" {
                        if let Some(g) = ctx.stack.last_mut() {
                            g.clip = inter;
                        }
                    }
                    ctx.path.clip_pending = false;
                }

                if (fill || stroke) && !bbox.is_empty() && ctx.path.segs.len() >= 2 {
                    let w = bbox.width();
                    let h = bbox.height();
                    let thin = single && w.min(h) <= 3.5 && (w / h).max(h / w) >= 3.0;
                    if thin {
                        self.items.rules.push(Rule {
                            rect: bbox,
                            color: if fill { gs.fill_color } else { gs.stroke_color },
                        });
                    } else {
                        self.items.paths.push(Path {
                            segs: ctx.path.segs.clone(),
                            fill,
                            stroke,
                            line_width: gs.line_width * gs.ctm.scale(),
                            fill_color: gs.fill_color,
                            stroke_color: gs.stroke_color,
                            bbox,
                        });
                    }
                }
                ctx.path.segs.clear();
                ctx.path.bbox = Rect::empty();
                ctx.path.single_rect = false;
            }

            "Do" => {
                if let Some(xname) = ops.first().and_then(|o| o.as_name()) {
                    let gsn = match ctx.stack.last() {
                        Some(g) => g.clone(),
                        None => return,
                    };
                    self.exec_do(&xname, &gsn, ctx);
                }
            }

            // Inline images come through as the synthetic op DoInline.
            "DoInline" => {
                if let Some(img) = pop_inline_image() {
                    let gsn = match ctx.stack.last() {
                        Some(g) => g.clone(),
                        None => return,
                    };
                    let corners: Vec<(f64, f64)> = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
                        .iter()
                        .map(|&(x, y)| gsn.ctm.apply(x, y))
                        .collect();
                    self.items.images.push(Image {
                        bbox: Rect::from_points(&corners),
                        source: ImageSource::Inline(img),
                    });
                }
            }

            _ => {}
        }
        ops.clear();
    }

    fn show_string(&mut self, bytes: &[u8], gs: &GState, ts: &mut TextState) {
        if ts.rendering == 3 || ts.rendering == 7 {
            return; // invisible text (OCR layer)
        }
        let font_idx = match ts.font {
            Some(i) => i,
            None => return,
        };
        // Clone the font info we need (avoids borrowing self.items twice).
        let font = self.items.fonts[font_idx].clone();

        let mut decoded: Vec<(u32, String, Option<String>, f64)> = Vec::new();
        if font.two_byte {
            let mut i = 0;
            while i + 1 < bytes.len() {
                let code = ((bytes[i] as u32) << 8) | bytes[i + 1] as u32;
                decoded.push(decode_code(&font, code));
                i += 2;
            }
        } else {
            for &b in bytes {
                decoded.push(decode_code(&font, b as u32));
            }
        }

        // Direction of the text-space x axis: rotated text (side stamps,
        // vertical captions) is skipped rather than mis-grouped into lines.
        let (tx_dir, ty_dir) = (gs.ctm.a * ts.tm.a + gs.ctm.c * ts.tm.b, gs.ctm.b * ts.tm.a + gs.ctm.d * ts.tm.b);
        let rotated = ty_dir.abs() > tx_dir.abs() * 2.0 && ty_dir.abs() > 0.01;

        for (code, text, latex, w0) in decoded {
            // Recompute the full transform PER GLYPH: Tm advances each time.
            let full = gs.ctm.mul(&ts.tm);
            let scale = ((full.a * full.d - full.b * full.c).abs().sqrt()).max(1e-6);
            let fsize = ts.size * scale;
            let (gx, gy) = full.apply(0.0, ts.rise);
            let glyph = Glyph {
                x: gx,
                y: gy,
                wx: w0 / 1000.0 * ts.size * ts.h_scale * scale,
                size: fsize,
                code,
                text: if rotated { String::new() } else { text },
                latex: if rotated { None } else { latex },
                font: font_idx,
            };
            if glyph.wx > 0.0 || !glyph.text.is_empty() {
                self.items.glyphs.push(glyph);
            }
            let tx = (w0 / 1000.0 * ts.size
                + ts.char_spacing
                + if code == 32 { ts.word_spacing } else { 0.0 })
                * ts.h_scale;
            ts.tm = translate(tx, 0.0).mul(&ts.tm);
        }
    }

    fn resolve_font(&mut self, resources: &Option<lopdf::Dictionary>, name: &str) -> Option<usize> {
        let res = resources.as_ref()?;
        let fonts = res.get(b"Font").ok()?;
        let fdict = match fonts {
            Object::Dictionary(d) => d.clone(),
            Object::Reference(rid) => match self.doc.get_object(*rid).ok()? {
                Object::Dictionary(d) => d.clone(),
                _ => return None,
            },
            _ => return None,
        };
        let obj = fdict.get(name.as_bytes()).ok()?.clone();
        let fid = match obj {
            Object::Reference(rid) => rid,
            _ => return None,
        };
        if let Some(&idx) = self.font_ids.get(&fid) {
            return Some(idx);
        }
        let info = if let Some(cached) = self.font_cache.get(&fid) {
            cached.clone()
        } else {
            let info = load_font(self.doc, fid).ok()?;
            self.font_cache.insert(fid, info.clone());
            info
        };
        self.items.fonts.push(info);
        let idx = self.items.fonts.len() - 1;
        self.font_ids.insert(fid, idx);
        Some(idx)
    }

    fn exec_do(&mut self, name: &str, gs: &GState, ctx: &mut RunCtx) {
        let res = match &ctx.resources {
            Some(r) => r.clone(),
            None => return,
        };
        let xobjs = match res.get(b"XObject") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(rid)) => match self.doc.get_object(*rid).ok() {
                Some(Object::Dictionary(d)) => d.clone(),
                _ => return,
            },
            _ => return,
        };
        let obj = match xobjs.get(name.as_bytes()) {
            Ok(o) => o.clone(),
            Err(_) => return,
        };
        let (id, dict) = match obj {
            Object::Reference(rid) => match self.doc.get_object(rid).ok() {
                Some(Object::Stream(s)) => (rid, s.dict.clone()),
                _ => return,
            },
            Object::Stream(s) => ((u32::MAX, 0u16), s.dict.clone()),
            _ => return,
        };

        let subtype = dict
            .get(b"Subtype")
            .ok()
            .and_then(|o| match o {
                Object::Name(n) => Some(String::from_utf8_lossy(&n).to_string()),
                _ => None,
            })
            .unwrap_or_default();

        let corners: Vec<(f64, f64)> = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
            .iter()
            .map(|&(x, y)| gs.ctm.apply(x, y))
            .collect();
        let bbox = Rect::from_points(&corners);

        match subtype.as_str() {
            "Image" => {
                if id.0 != u32::MAX {
                    self.items
                        .images
                        .push(Image { bbox, source: ImageSource::XObject(id) });
                }
            }
            "Form" => {
                if id.0 == u32::MAX {
                    return;
                }
                let mut content = match self.doc.get_object(id) {
                    Ok(Object::Stream(s)) => {
                        let mut sc = s.clone();
                        if sc.decode_content().is_ok() {
                            sc.content
                        } else {
                            s.content.clone()
                        }
                    }
                    _ => return,
                };
                if content.is_empty() {
                    content = vec![b' '];
                }
                let form_res = dict.get(b"Resources").cloned().ok();
                let sub_resources = match form_res {
                    Some(Object::Dictionary(d)) => Some(d),
                    Some(Object::Reference(rid)) => match self.doc.get_object(rid).ok() {
                        Some(Object::Dictionary(d)) => Some(d.clone()),
                        _ => ctx.resources.clone(),
                    },
                    _ => ctx.resources.clone(),
                };
                let matrix = dict
                    .get(b"Matrix")
                    .ok()
                    .and_then(|o| match o {
                        Object::Array(a) if a.len() == 6 => {
                            let v: Vec<f64> = a.iter().filter_map(as_f64).collect();
                            (v.len() == 6).then(|| Mat {
                                a: v[0],
                                b: v[1],
                                c: v[2],
                                d: v[3],
                                e: v[4],
                                f: v[5],
                            })
                        }
                        _ => None,
                    })
                    .unwrap_or(Mat::IDENTITY);

                let saved_ts = std::mem::replace(&mut ctx.ts, TextState::new());
                let saved_stack_len = ctx.stack.len();
                let saved_res = ctx.resources.clone();
                ctx.resources = sub_resources;
                // q ... Q semantics for the form: its Matrix composes with the
                // current CTM.
                ctx.stack.push(gs.clone());
                if let Some(g) = ctx.stack.last_mut() {
                    g.ctm = matrix.mul(&gs.ctm);
                }
                self.run(&content, ctx);
                while ctx.stack.len() > saved_stack_len {
                    ctx.stack.pop();
                }
                ctx.resources = saved_res;
                ctx.ts = saved_ts;
            }
            _ => {}
        }
    }
}

fn set_fill(ctx: &mut RunCtx, r: f64, g: f64, b: f64) {
    if let Some(gs) = ctx.stack.last_mut() {
        gs.fill_color = (r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0));
    }
}

fn set_stroke(ctx: &mut RunCtx, r: f64, g: f64, b: f64) {
    if let Some(gs) = ctx.stack.last_mut() {
        gs.stroke_color = (r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0));
    }
}

fn translate(tx: f64, ty: f64) -> Mat {
    Mat { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: tx, f: ty }
}

fn cmyk(ops: &[Op]) -> (f64, f64, f64) {
    let c = ops.first().and_then(|o| o.as_f64()).unwrap_or(0.0);
    let m = ops.get(1).and_then(|o| o.as_f64()).unwrap_or(0.0);
    let y = ops.get(2).and_then(|o| o.as_f64()).unwrap_or(0.0);
    let k = ops.get(3).and_then(|o| o.as_f64()).unwrap_or(0.0);
    (
        (1.0 - c.min(1.0)) * (1.0 - k),
        (1.0 - m.min(1.0)) * (1.0 - k),
        (1.0 - y.min(1.0)) * (1.0 - k),
    )
}

fn as_f64(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn decode_code(font: &FontInfo, code: u32) -> (u32, String, Option<String>, f64) {
    let text = font.decode(code);
    let latex = if font.tex != TexKind::None {
        crate::glyphdata::cm_slot_latex(font.tex.table_id(), (code & 0xFF) as u8).map(|s| s.to_string())
    } else if font.is_math {
        let mut out: Option<String> = None;
        for ch in text.chars() {
            out = Some(
                crate::glyphdata::uni_to_latex(ch as u32)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| text.clone()),
            );
            break;
        }
        out
    } else {
        None
    };
    (code, text, latex, font.width_of(code))
}

struct RunCtx {
    stack: Vec<GState>,
    ts: TextState,
    path: PathState,
    resources: Option<lopdf::Dictionary>,
}

thread_local! {
    static INLINE_IMAGES: std::cell::RefCell<Vec<InlineImage>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn pop_inline_image() -> Option<InlineImage> {
    INLINE_IMAGES.with(|q| q.borrow_mut().pop())
}

// --------------------------------------------------------------------------
// Content stream parser
// --------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Op {
    Num(f64),
    String(Vec<u8>),
    Name(String),
    Array(Vec<Op>),
    Dict,
    Bool(bool),
    Null,
}

impl Op {
    fn as_f64(&self) -> Option<f64> {
        match self {
            Op::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn as_name(&self) -> Option<String> {
        match self {
            Op::Name(n) => Some(n.clone()),
            _ => None,
        }
    }
}

pub enum Token {
    Operand(Op),
    Op(String),
}

pub struct Parser<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    pub fn new(data: &'a [u8]) -> Parser<'a> {
        Parser { data, pos: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.data.len() {
            match self.data[self.pos] {
                b' ' | b'\n' | b'\r' | b'\t' | 0x0C | 0x00 => self.pos += 1,
                b'%' => {
                    while self.pos < self.data.len() && self.data[self.pos] != b'\n' {
                        self.pos += 1;
                    }
                }
                _ => break,
            }
        }
    }

    pub fn next_token(&mut self) -> Option<Token> {
        self.skip_ws();
        if self.pos >= self.data.len() {
            return None;
        }
        let c = self.data[self.pos];
        match c {
            b'0'..=b'9' | b'.' | b'-' | b'+' => {
                let start = self.pos;
                self.pos += 1;
                while self.pos < self.data.len()
                    && (self.data[self.pos].is_ascii_digit()
                        || matches!(self.data[self.pos], b'.' | b'-' | b'+' | b'e' | b'E'))
                {
                    self.pos += 1;
                }
                let s = std::str::from_utf8(&self.data[start..self.pos]).ok()?;
                Some(Token::Operand(Op::Num(s.parse().unwrap_or(0.0))))
            }
            b'/' => {
                self.pos += 1;
                let start = self.pos;
                while self.pos < self.data.len() && !is_delim(self.data[self.pos]) {
                    self.pos += 1;
                }
                Some(Token::Operand(Op::Name(decode_name(&self.data[start..self.pos]))))
            }
            b'(' => {
                let (bytes, np) = read_literal_string(self.data, self.pos)?;
                self.pos = np;
                Some(Token::Operand(Op::String(bytes)))
            }
            b'<' if self.data.get(self.pos + 1) == Some(&b'<') => {
                let mut depth = 0i32;
                while self.pos < self.data.len() {
                    if self.data[self.pos..].starts_with(b"<<") {
                        depth += 1;
                        self.pos += 2;
                    } else if self.data[self.pos..].starts_with(b">>") {
                        depth -= 1;
                        self.pos += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        self.pos += 1;
                    }
                }
                Some(Token::Operand(Op::Dict))
            }
            b'<' => {
                self.pos += 1;
                let end = self.data[self.pos..].iter().position(|&c| c == b'>')? + self.pos;
                let hexs: Vec<u8> = self.data[self.pos..end]
                    .iter()
                    .cloned()
                    .filter(|b| b.is_ascii_hexdigit())
                    .collect();
                let mut bytes = Vec::with_capacity(hexs.len() / 2 + 1);
                let mut i = 0;
                while i + 1 < hexs.len() {
                    bytes.push(hexval(hexs[i])? * 16 + hexval(hexs[i + 1])?);
                    i += 2;
                }
                if i < hexs.len() {
                    bytes.push(hexval(hexs[i]).unwrap_or(0) * 16);
                }
                self.pos = end + 1;
                Some(Token::Operand(Op::String(bytes)))
            }
            b'[' => {
                self.pos += 1;
                let mut arr = Vec::new();
                loop {
                    self.skip_ws();
                    if self.pos >= self.data.len() {
                        break;
                    }
                    if self.data[self.pos] == b']' {
                        self.pos += 1;
                        break;
                    }
                    match self.next_token() {
                        Some(Token::Operand(o)) => arr.push(o),
                        Some(Token::Op(w)) => {
                            // Token operators inside arrays are not valid PDF;
                            // treat as operand-free op.
                            let _ = w;
                        }
                        None => break,
                    }
                }
                Some(Token::Operand(Op::Array(arr)))
            }
            b']' | b'>' | b')' => {
                self.pos += 1;
                Some(Token::Op("]".into()))
            }
            b'{' | b'}' => {
                self.pos += 1;
                Some(Token::Op(String::from_utf8_lossy(&[c]).to_string()))
            }
            _ => {
                let start = self.pos;
                while self.pos < self.data.len() && !is_delim(self.data[self.pos]) {
                    self.pos += 1;
                }
                let word = String::from_utf8_lossy(&self.data[start..self.pos]).to_string();
                if word == "BI" {
                    return self.read_inline_image();
                }
                Some(Token::Op(word))
            }
        }
    }

    /// After BI: reads the key/value dict, binary data between ID and EI, and
    /// emits the synthetic operator `DoInline` (image stashed in a slot).
    fn read_inline_image(&mut self) -> Option<Token> {
        let mut width = 0u32;
        let mut height = 0u32;
        let mut bits = 8u32;
        let mut cs = "DeviceGray".to_string();
        let mut filter = String::new();
        loop {
            self.skip_ws();
            if self.pos >= self.data.len() {
                return None;
            }
            if self.data[self.pos] == b'I' && self.data.get(self.pos + 1) == Some(&b'D') {
                self.pos += 2;
                break;
            }
            if self.data[self.pos] != b'/' {
                self.pos += 1;
                continue;
            }
            self.pos += 1;
            let ks = self.pos;
            while self.pos < self.data.len() && !is_delim(self.data[self.pos]) {
                self.pos += 1;
            }
            let key = String::from_utf8_lossy(&self.data[ks..self.pos]).to_string();
            self.skip_ws();
            let vs = self.pos;
            while self.pos < self.data.len()
                && !is_delim(self.data[self.pos])
                && self.data[self.pos] != b'I'
            {
                self.pos += 1;
            }
            let val = String::from_utf8_lossy(&self.data[vs..self.pos]).trim().to_string();
            let val_num = val.trim_start_matches('/');
            match key.as_str() {
                "W" => width = val_num.parse().unwrap_or(0),
                "H" => height = val_num.parse().unwrap_or(0),
                "BPC" => bits = val_num.parse().unwrap_or(8),
                "CS" => cs = val_num.to_string(),
                "F" => filter = val_num.to_string(),
                _ => {}
            }
        }
        if self.pos < self.data.len() && (self.data[self.pos] == b'\n' || self.data[self.pos] == b'\r') {
            self.pos += 1;
        }
        let mut end = self.pos;
        while end + 2 < self.data.len() {
            if self.data[end] == b'E'
                && self.data[end + 1] == b'I'
                && self.data[end - 1].is_ascii_whitespace()
                && self
                    .data
                    .get(end + 2)
                    .map(|c| c.is_ascii_whitespace() || *c == b'Q' || *c == b'q')
                    .unwrap_or(true)
            {
                break;
            }
            end += 1;
        }
        let data = self.data[self.pos..end.min(self.data.len())].to_vec();
        self.pos = (end + 2).min(self.data.len());
        INLINE_IMAGES.with(|q| {
            q.borrow_mut().push(InlineImage {
                data,
                width,
                height,
                bits,
                color_space: cs,
                filter,
            })
        });
        Some(Token::Op("DoInline".into()))
    }
}

fn is_delim(c: u8) -> bool {
    matches!(
        c,
        b' ' | b'\n' | b'\r' | b'\t' | b'/' | b'<' | b'>' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'%'
    )
}

fn decode_name(raw: &[u8]) -> String {
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'#' && i + 2 < raw.len() {
            if let (Some(h), Some(l)) = (hexval(raw[i + 1]), hexval(raw[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Reads a PDF literal string starting at `data[start] == b'('`.
fn read_literal_string(data: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    let mut i = start + 1;
    let mut depth = 1;
    let mut out = Vec::new();
    while i < data.len() {
        match data[i] {
            b'\\' => {
                i += 1;
                if i >= data.len() {
                    break;
                }
                match data[i] {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' => out.push(0x08),
                    b'f' => out.push(0x0C),
                    b'(' => out.push(b'('),
                    b')' => out.push(b')'),
                    b'\\' => out.push(b'\\'),
                    b'\n' => {}
                    b'0'..=b'7' => {
                        let mut v = data[i] - b'0';
                        let mut used = 1;
                        while used < 3
                            && i + used < data.len()
                            && (b'0'..=b'7').contains(&data[i + used])
                        {
                            v = v * 8 + (data[i + used] - b'0');
                            used += 1;
                        }
                        out.push(v);
                        i += used - 1;
                    }
                    _ => out.push(data[i]),
                }
                i += 1;
            }
            b'(' => {
                depth += 1;
                out.push(b'(');
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((out, i + 1));
                }
                out.push(b')');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

// --------------------------------------------------------------------------
// Page-level helpers
// --------------------------------------------------------------------------

/// Returns (MediaBox, Resources dict) walking up the page tree.
fn page_attrs(doc: &Document, page_id: lopdf::ObjectId) -> (Option<Rect>, Option<lopdf::Dictionary>) {
    let mut media: Option<Rect> = None;
    let mut resources: Option<lopdf::Dictionary> = None;
    let mut cur = Some(page_id);
    let mut guard = 0;
    while let Some(id) = cur {
        guard += 1;
        if guard > 64 {
            break;
        }
        let obj = match doc.get_object(id) {
            Ok(o) => o.clone(),
            Err(_) => break,
        };
        let dict = match obj {
            Object::Dictionary(d) => d,
            Object::Stream(s) => s.dict,
            _ => break,
        };
        if media.is_none() {
            if let Ok(mb) = dict.get(b"MediaBox") {
                media = obj_to_rect(mb);
            }
        }
        if resources.is_none() {
            match dict.get(b"Resources").cloned() {
                Ok(Object::Dictionary(d)) => resources = Some(d),
                Ok(Object::Reference(rid)) => {
                    if let Some(Object::Dictionary(d)) = doc.get_object(rid).ok() {
                        resources = Some(d.clone());
                    }
                }
                _ => {}
            }
        }
        cur = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    }
    (media, resources)
}

fn obj_to_rect(o: &Object) -> Option<Rect> {
    if let Object::Array(a) = o {
        let v: Vec<f64> = a.iter().filter_map(as_f64).collect();
        if v.len() == 4 {
            return Some(Rect {
                x0: v[0].min(v[2]),
                y0: v[1].min(v[3]),
                x1: v[0].max(v[2]),
                y1: v[1].max(v[3]),
            });
        }
    }
    None
}

/// Concatenates all /Contents streams of a page, decoded.
pub fn page_content_bytes(doc: &Document, page_id: lopdf::ObjectId) -> Result<Vec<u8>, String> {
    let obj = doc.get_object(page_id).map_err(|e| e.to_string())?;
    let dict = match obj {
        Object::Dictionary(d) => d.clone(),
        Object::Stream(s) => s.dict.clone(),
        _ => return Err("page: not a dict".into()),
    };
    let contents = dict.get(b"Contents").cloned().unwrap_or(Object::Null);
    let mut out = Vec::new();
    match contents {
        Object::Reference(rid) => out.extend_from_slice(&decode_stream(doc, rid)?),
        Object::Array(arr) => {
            for o in &arr {
                if let Object::Reference(rid) = o {
                    out.extend_from_slice(&decode_stream(doc, *rid)?);
                    out.push(b' ');
                }
            }
        }
        Object::Stream(s) => {
            out.extend_from_slice(&s.decompressed_content().map_err(|e| e.to_string())?);
        }
        _ => {}
    }
    Ok(out)
}

fn decode_stream(doc: &Document, id: lopdf::ObjectId) -> Result<Vec<u8>, String> {
    match doc.get_object(id).map_err(|e| e.to_string())? {
        Object::Stream(s) => s
            .decompressed_content()
            .map_err(|e| format!("stream decode: {}", e)),
        _ => Err("content: not a stream".into()),
    }
}

/// Extracts the raw (still-filtered) stream data of an object.
pub fn raw_stream(doc: &Document, id: lopdf::ObjectId) -> Option<Vec<u8>> {
    match doc.get_object(id).ok()? {
        Object::Stream(s) => Some(s.content.clone()),
        _ => None,
    }
}

/// Decodes a stream applying FlateDecode if present; leaves DCT as-is.
pub fn decoded_stream(doc: &Document, id: lopdf::ObjectId) -> Option<(Vec<u8>, Vec<String>)> {
    match doc.get_object(id).ok()? {
        Object::Stream(s) => {
            let filters: Vec<String> = match s.dict.get(b"Filter") {
                Ok(Object::Name(n)) => vec![String::from_utf8_lossy(n).to_string()],
                Ok(Object::Array(a)) => a
                    .iter()
                    .filter_map(|o| match o {
                        Object::Name(n) => Some(String::from_utf8_lossy(n).to_string()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let data = s.content.clone();
            Some((data, filters))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_td_positioning() {
        let flip = Mat { a: 1.0, b: 0.0, c: 0.0, d: -1.0, e: 0.0, f: 792.0 };
        let mut ts = TextState::new();
        ts.size = 11.9552;
        // Td 108 710.037
        ts.tlm = translate(108.0, 710.037).mul(&ts.tlm);
        ts.tm = ts.tlm;
        let full = flip.mul(&ts.tm);
        let (x, y) = full.apply(0.0, 0.0);
        assert!((y - 81.96).abs() < 0.1, "y was {}", y);
        assert!((x - 108.0).abs() < 0.1);
        // Tm 1.02 0 0 1 108 685.354
        ts.tm = Mat { a: 1.02, b: 0.0, c: 0.0, d: 1.0, e: 108.0, f: 685.354 };
        ts.tlm = ts.tm;
        let full = flip.mul(&ts.tm);
        let (x, y) = full.apply(0.0, 0.0);
        assert!((x - 108.0).abs() < 0.1, "x was {}", x);
        assert!((y - 106.65).abs() < 0.1, "y was {}", y);
    }
}
