//! PDF font dictionaries: encodings (ToUnicode CMap, /Encoding differences,
//! built-in standards), widths, and classification (math / bold / italic / mono).

use crate::glyphdata;
use std::collections::HashMap;

use lopdf::{Document, Object};

/// Which classic TeX charcode table applies to this font, if any.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TexKind {
    None,
    Cmmi,
    Cmsy,
    Cmex,
    Cmr,
}

impl TexKind {
    /// Table id in glyphdata::CM_SLOTS (0=cmmi 1=cmsy 2=cmex 3=cmr).
    pub fn table_id(self) -> u8 {
        match self {
            TexKind::None => u8::MAX,
            TexKind::Cmmi => 0,
            TexKind::Cmsy => 1,
            TexKind::Cmex => 2,
            TexKind::Cmr => 3,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FontInfo {
    /// Base font name with subset prefix (ABCDEF+) stripped.
    pub base: String,
    /// Type0 fonts use two-byte codes.
    pub two_byte: bool,
    /// code (or CID) -> unicode string.
    pub to_unicode: HashMap<u32, String>,
    /// Glyph name per code from /Encoding Differences (simple fonts).
    pub differences: HashMap<u32, String>,
    /// /Encoding base: 0=Standard, 1=WinAnsi, 2=MacRoman, 3=PDFDoc, 4=Symbol, 5=ZapfDingbats.
    pub base_encoding: u8,
    /// code -> glyph advance (1/1000 em).
    pub widths: HashMap<u32, f64>,
    /// Default advance (1/1000 em) for CID fonts (/DW); falls back to 500.
    pub default_width: f64,
    /// code -> glyph name read from the EMBEDDED Type1 font program's own
    /// /Encoding array. dvips-style TeX subsets keep no /Encoding in the PDF
    /// font dict and no ToUnicode, and they re-encode slots arbitrarily
    /// (1406.2661 carries ∼ at code 24 and the \not slash at 54) — the
    /// embedded array is the only authoritative code → glyph table.
    pub embedded_names: HashMap<u32, String>,
    pub is_symbolic: bool,
    // classification
    pub is_math: bool,
    pub is_bold: bool,
    pub is_italic: bool,
    pub is_mono: bool,
    pub tex: TexKind,
    /// Width of the space glyph if the font has one.
    pub space_width: f64,
}

impl FontInfo {
    pub fn new() -> FontInfo {
        FontInfo {
            base: String::new(),
            two_byte: false,
            to_unicode: HashMap::new(),
            differences: HashMap::new(),
            base_encoding: 0,
            widths: HashMap::new(),
            default_width: 500.0,
            embedded_names: HashMap::new(),
            is_symbolic: false,
            is_math: false,
            is_bold: false,
            is_italic: false,
            is_mono: false,
            tex: TexKind::None,
            space_width: 0.25,
        }
    }

    /// Resolves a character code to its unicode string.
    pub fn decode(&self, code: u32) -> String {
        if let Some(s) = self.to_unicode.get(&code) {
            return s.clone();
        }
        if let Some(name) = self.differences.get(&code) {
            if let Some(s) = crate::glyphdata::agl_lookup(name) {
                return s.to_string();
            }
            if let Some(s) = agl_fallback(name) {
                return s;
            }
        }
        // The embedded font's own encoding: authoritative for re-encoded
        // subsets (e.g. ∼ parked at code 24 by dvips).
        if let Some(name) = self.embedded_names.get(&code) {
            if let Some(s) = crate::glyphdata::agl_lookup(name) {
                return s.to_string();
            }
            if let Some(s) = agl_fallback(name) {
                return s;
            }
        }
        match self.base_encoding {
            1 => win_ansi(code as u8),
            2 => mac_roman(code as u8),
            3 => pdf_doc(code as u8),
            4 => symbol_char(code as u8),
            5 => zapf_char(code as u8),
            _ => {
                if self.tex != TexKind::None {
                    // A TeX font reached this fallthrough only when neither
                    // ToUnicode, /Differences nor the embedded encoding names
                    // the code. StandardEncoding ASCII would fabricate wrong
                    // letters (cmsy 54 printed "6" for ¬, 106 printed "j" for
                    // |) — an empty text is honest: the LaTeX side may still
                    // know the glyph.
                    return String::new();
                }
                if self.is_symbolic {
                    std_char(code as u8)
                } else {
                    std_char(code as u8)
                }
            }
        }
    }

    pub fn width_of(&self, code: u32) -> f64 {
        *self
            .widths
            .get(&code)
            .unwrap_or(&if self.two_byte { self.default_width } else { 500.0 })
    }
}

/// Resolves indirect references (following chains up to 8 deep).
pub fn resolve_obj(doc: &Document, o: &Object) -> Object {
    let mut cur = o.clone();
    for _ in 0..8 {
        match cur {
            Object::Reference(rid) => match doc.get_object(rid) {
                Ok(next) => cur = next.clone(),
                Err(_) => return Object::Null,
            },
            _ => return cur,
        }
    }
    cur
}

/// Loads (or builds) the font info for a font object reference.
pub fn load_font(doc: &Document, id: lopdf::ObjectId) -> Result<FontInfo, String> {
    let obj = doc.get_object(id).map_err(|e| format!("font {:?}: {}", id, e))?;
    let dict = match obj {
        Object::Dictionary(d) => d.clone(),
        Object::Stream(s) => s.dict.clone(),
        _ => return Err(format!("font {:?}: not a dictionary", id)),
    };
    let mut f = FontInfo::new();

    let subtype = dict.get(b"Subtype").ok().and_then(obj_name).unwrap_or_default();
    let base_name = dict.get(b"BaseFont").ok().and_then(obj_name).unwrap_or_default();
    f.base = strip_subset(&base_name);

    let df_id = descendant_font_id(&dict);
    let is_type0 = subtype == "Type0";
    if is_type0 {
        f.two_byte = true;
    }

    // Widths live on the descendant for Type0, on the font itself otherwise.
    if is_type0 {
        if let Some(df) = df_id {
            if let Ok(Object::Dictionary(dd)) = doc.get_object(df) {
                parse_cid_widths(doc, dd, &mut f);
            }
        }
    } else {
        parse_simple_widths(doc, &dict, &mut f);
    }
    if std::env::var("PDF2MD_FONT_DEBUG").is_ok() {
        eprintln!(
            "FONT {:?} subtype={} widths={} first={:?} widths_arr={:?}",
            f.base,
            subtype,
            f.widths.len(),
            dict.get(b"FirstChar").map(|o| o.as_i64()),
            dict.get(b"Widths").map(|o| match o {
                Object::Array(a) => format!("Array({})", a.len()),
                other => format!("{:?}", other),
            }),
        );
    }

    // Flags / classification (from descendant for Type0)
    let flag_src_id = if is_type0 { df_id } else { Some(id) };
    if let Some(fid) = flag_src_id {
        if let Ok(Object::Dictionary(fd)) = doc.get_object(fid) {
            if let Ok(Object::Integer(flags)) = fd.get(b"Flags") {
                let fl = *flags as u32;
                f.is_symbolic = fl & 4 != 0;
            }
            if let Ok(Object::Integer(it)) = fd.get(b"ItalicAngle") {
                f.is_italic = *it != 0;
            }
        }
    }
    classify(&mut f);

    // ToUnicode
    if let Ok(tid) = dict.get(b"ToUnicode").cloned() {
        let ts = match tid {
            Object::Reference(rid) => doc.get_object(rid).ok().cloned(),
            Object::Stream(s) => Some(Object::Stream(s)),
            _ => None,
        };
        if let Some(Object::Stream(ts)) = ts {
            if let Ok(data) = ts.decompressed_content() {
                f.to_unicode = parse_tounicode(&data);
            }
        }
    }

    // /Encoding (simple fonts)
    if !is_type0 {
        if let Ok(enc) = dict.get(b"Encoding") {
            let enc = enc.clone();
            parse_encoding(doc, &enc, &mut f);
        }
    }

    // Embedded Type1 program: read the font's own /Encoding array (the clear
    // part before eexec). This is the ground truth for TeX subsets that keep
    // no PDF-level encoding at all.
    f.embedded_names = load_embedded_type1_encoding(doc, &dict);

    Ok(f)
}

/// Extracts `code → glyph name` from an embedded Type1 font program's
/// /Encoding array (`/Encoding 256 array ... dup N /Name put ... readonly`).
fn load_embedded_type1_encoding(doc: &Document, dict: &lopdf::Dictionary) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let Some(desc) = dict.get(b"FontDescriptor").ok().map(|o| resolve_obj(doc, o)) else {
        return out;
    };
    let desc = match desc {
        Object::Dictionary(d) => d,
        _ => return out,
    };
    let file_ref = desc
        .get(b"FontFile")
        .or_else(|_| desc.get(b"FontFile3"))
        .ok()
        .cloned();
    let Some(file_ref) = file_ref else { return out };
    let stream = match resolve_obj(doc, &file_ref) {
        Object::Stream(s) => s,
        _ => return out,
    };
    // CFF-flavoured fonts (FontFile3 /Type1C, /CIDFontType0C) carry the
    // charset in CFF form, not PostScript dups — skip them here.
    if let Ok(sub) = stream.dict.get(b"Subtype") {
        if let Some(name) = obj_name(sub) {
            if name == "Type1C" || name == "CIDFontType0C" || name == "OpenType" {
                return out;
            }
        }
    }
    let Ok(data) = stream.decompressed_content() else {
        return out;
    };
    // Only the clear (non-eexec) part can declare /Encoding.
    let clear_end = data
        .windows(6)
        .position(|w| w == b"eexec\n")
        .or_else(|| data.windows(7).position(|w| w == b"eexec\r\n"))
        .unwrap_or(data.len());
    let clear = &data[..clear_end];
    let Some(enc_pos) = clear.windows(9).position(|w| w == b"/Encoding") else {
        return out;
    };
    let rest = &clear[enc_pos + 9..];
    if rest.starts_with(b"StandardEncoding") || rest.starts_with(b"ISOLatin1") {
        return out;
    }
    // Scan `dup <code> /<Name> put` entries until readonly/def/end.
    let is_ws = |b: u8| b == b' ' || b == b'\n' || b == b'\r' || b == b'\t';
    let token_at = |rest: &[u8], i: usize, tok: &[u8]| -> bool {
        rest[i..].starts_with(tok)
            && (i == 0 || is_ws(rest[i - 1]))
            && (i + tok.len() >= rest.len() || is_ws(rest[i + tok.len()]))
    };
    let mut i = 0;
    while i + 4 < rest.len() {
        if token_at(rest, i, b"readonly")
            || token_at(rest, i, b"currentdict")
            || token_at(rest, i, b"currentfile")
            || token_at(rest, i, b"end")
            // "def" only as a standalone token — the loop prologue contains
            // "/.notdef put" and a bare starts_with("def") stopped the scan
            // before the first dup (every TeX subset decoded to empty text)
            || token_at(rest, i, b"def")
        {
            break;
        }
        if rest[i..].starts_with(b"dup") {
            let mut j = i + 3;
            while j < rest.len() && (rest[j] == b' ' || rest[j] == b'\n' || rest[j] == b'\r' || rest[j] == b'\t') {
                j += 1;
            }
            let ds = j;
            while j < rest.len() && rest[j].is_ascii_digit() {
                j += 1;
            }
            let code: u32 = std::str::from_utf8(&rest[ds..j]).ok().and_then(|s| s.parse().ok()).unwrap_or(u32::MAX);
            while j < rest.len() && (rest[j] == b' ' || rest[j] == b'\n' || rest[j] == b'\r' || rest[j] == b'\t') {
                j += 1;
            }
            if j < rest.len() && rest[j] == b'/' && code != u32::MAX {
                j += 1;
                let ns = j;
                while j < rest.len() && rest[j].is_ascii_alphanumeric() {
                    j += 1;
                }
                let name = String::from_utf8_lossy(&rest[ns..j]).to_string();
                if !name.is_empty() && name != ".notdef" {
                    out.entry(code).or_insert(name);
                }
            }
        }
        i += 1;
    }
    out
}

fn descendant_font_id(dict: &lopdf::Dictionary) -> Option<lopdf::ObjectId> {
    dict.get(b"DescendantFonts")
        .ok()?
        .as_array()
        .ok()?
        .first()?
        .as_reference()
        .ok()
}

fn parse_simple_widths(doc: &Document, dict: &lopdf::Dictionary, f: &mut FontInfo) {
    let first = dict.get(b"FirstChar").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    if let Some(Object::Array(arr)) = dict
        .get(b"Widths")
        .ok()
        .map(|o| resolve_obj(doc, o))
    {
        for (i, w) in arr.iter().enumerate() {
            if let Some(v) = as_f64(w) {
                f.widths.insert(first + i as u32, v);
            }
        }
    }
    if let Some(space) = f.widths.get(&(32u32)) {
        f.space_width = *space;
    } else {
        // Heuristic: average of digits ≈ body advance.
        let mut sum = 0.0;
        let mut n = 0;
        for c in 48..58 {
            if let Some(w) = f.widths.get(&c) {
                sum += *w;
                n += 1;
            }
        }
        if n > 0 {
            f.space_width = sum / n as f64 * 0.30;
        }
    }
}

fn parse_cid_widths(doc: &Document, dict: &lopdf::Dictionary, f: &mut FontInfo) {
    let Some(Object::Array(arr)) = dict.get(b"W").ok().map(|o| resolve_obj(doc, o)) else {
        return;
    };
    if let Some(dw) = dict.get(b"DW").ok().and_then(as_f64) {
        f.default_width = dw;
    }
    // The W array holds two entry forms, told apart by the type of the SECOND
    // element:
    //   c [w1 w2 ...]  — codes c..c+n-1 carry widths w1..wn (second elem: Array)
    //   c1 c2 w        — every code in c1..=c2 carries width w (second: int)
    // The old code dispatched on `arr[i+1].as_i64()` — exactly inverted: for
    // `c [w…]` it inserted the NEXT CODE as c's width ("A" got 42), and for
    // `c1 c2 w` it looked for an array that is never there. Every CID font
    // advance was garbage, words interleaved and spaces vanished (the whole
    // 2609.27549 fixture text was scrambled this way).
    let mut i = 0;
    while i < arr.len() {
        let Some(c) = arr.get(i).and_then(|o| o.as_i64().ok()) else {
            i += 1;
            continue;
        };
        if c < 0 {
            i += 1;
            continue;
        }
        match arr.get(i + 1) {
            Some(Object::Array(ws)) => {
                for (k, w) in ws.iter().enumerate() {
                    if let Some(v) = as_f64(w) {
                        f.widths.insert((c + k as i64) as u32, v);
                    }
                }
                i += 2;
            }
            Some(o2) => {
                let Some(c2) = o2.as_i64().ok() else {
                    i += 1;
                    continue;
                };
                if let Some(w) = arr.get(i + 2).and_then(as_f64) {
                    // a RANGE: every code from c to c2 gets w (the old code
                    // filled only c, leaving the rest of the range at the
                    // default)
                    for cc in c..=c2 {
                        f.widths.insert(cc as u32, w);
                    }
                }
                i += 3;
            }
            None => break,
        }
    }
    if let Some(space) = f.widths.get(&32) {
        f.space_width = *space;
    }
}

fn parse_encoding(doc: &Document, enc: &Object, f: &mut FontInfo) {
    match enc {
        Object::Name(n) => {
            f.base_encoding = std_encoding_id(&String::from_utf8_lossy(n));
        }
        Object::Dictionary(d) => {
            if let Ok(Object::Name(base)) = d.get(b"BaseEncoding") {
                f.base_encoding = std_encoding_id(&String::from_utf8_lossy(base));
            }
            if let Ok(Object::Array(diffs)) = d.get(b"Differences") {
                let mut code: u32 = 0;
                for item in diffs {
                    match item {
                        Object::Integer(i) => code = *i as u32,
                        Object::Name(n) => {
                            f.differences.insert(code, String::from_utf8_lossy(n).to_string());
                            code += 1;
                        }
                        _ => {}
                    }
                }
            }
        }
        Object::Reference(rid) => {
            let resolved = doc.get_object(*rid).cloned().unwrap_or(Object::Null);
            parse_encoding(doc, &resolved, f);
        }
        _ => {}
    }
}

fn std_encoding_id(name: &str) -> u8 {
    match name {
        "WinAnsiEncoding" => 1,
        "MacRomanEncoding" => 2,
        "PDFDocEncoding" => 3,
        "Symbol" => 4,
        "ZapfDingbats" => 5,
        _ => 0,
    }
}

fn strip_subset(name: &str) -> String {
    if name.len() >= 8 && name.as_bytes()[6] == b'+' {
        name[7..].to_string()
    } else {
        name.to_string()
    }
}

fn classify(f: &mut FontInfo) {
    let n = f.base.to_lowercase();
    // Symbol/standard math-ish encodings
    if n == "symbol" {
        f.is_math = true;
    }
    // Computer Modern / AMSTeX / LaTeX math fonts
    for key in ["cmmi", "cmsy", "cmex", "cmbsy", "msam", "msbm", "eufm", "eusb", "eufb", "msam", "math"] {
        if n.contains(key) {
            f.is_math = true;
        }
    }
    // Math italic suffixes (e.g. NimbusRomNo9L-ReguItal is not math; be strict)
    //
    // The BOLD families carry the same charcode tables as their regular
    // counterparts (cmbx10 is cmr10 at a bold weight, cmbsy10 is cmsy10): a
    // paper that sets a formula's numbers in cmbx — Table 2 of 1706.03762 has
    // `3.3 · 10^18` in CMBX10/CMBSY10 — left them outside the math path (the
    // shared path gates on "is a TeX font", `tex != None`) and the superscript
    // stayed flat (`3.3 · 1018`).
    if n.starts_with("cmmi") || n.starts_with("cmmib") {
        f.tex = TexKind::Cmmi;
    } else if n.starts_with("cmsy") || n.starts_with("cmbsy") {
        f.tex = TexKind::Cmsy;
    } else if n.starts_with("cmex") || n.starts_with("cmbex") {
        f.tex = TexKind::Cmex;
    } else if n.starts_with("cmr") || n.starts_with("cmbx") || n.starts_with("cmss") {
        f.tex = TexKind::Cmr;
    }
    // STIX / XITS math fonts
    if n.contains("stix") || n.contains("xits") {
        f.is_math = true;
    }
    // Explicit "italic"/"oblique" in name
    if n.contains("italic") || n.contains("oblique") {
        f.is_italic = true;
    }
    if n.contains("bold") || n.contains("black") || n.contains("heavy") {
        f.is_bold = true;
    }
    // Mono fonts
    for key in ["courier", "mono", "consola", "menlo", "fira", "jetbrains", "typewriter"] {
        if n.contains(key) {
            f.is_mono = true;
        }
    }
}

fn obj_name(o: &Object) -> Option<String> {
    match o {
        Object::Name(n) => Some(String::from_utf8_lossy(n).to_string()),
        _ => None,
    }
}

fn as_f64(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

// --------------------------------------------------------------------------
// ToUnicode CMap parsing
// --------------------------------------------------------------------------

fn parse_tounicode(data: &[u8]) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let text = String::from_utf8_lossy(data);
    let bytes = text.as_bytes();

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"beginbfchar") {
            i += b"beginbfchar".len();
            while i < bytes.len() && !bytes[i..].starts_with(b"endbfchar") {
                if let Some((src, dst, next)) = parse_bf_entry(bytes, i) {
                    map.insert(src, dst);
                    i = next;
                } else {
                    i += 1;
                }
            }
            i += b"endbfchar".len();
        } else if bytes[i..].starts_with(b"beginbfrange") {
            i += b"beginbfrange".len();
            while i < bytes.len() && !bytes[i..].starts_with(b"endbfrange") {
                if let Some((lo, hi, dsts, next)) = parse_bfrange_entry(bytes, i) {
                    match dsts {
                        RangeDst::Single(s) => {
                            let base = hex_to_u32(&s);
                            for c in lo..=hi {
                                let v = base + (c - lo);
                                map.insert(c, utf16be_decode(v));
                            }
                        }
                        RangeDst::List(list) => {
                            for (k, c) in (lo..=hi).enumerate() {
                                if let Some(s) = list.get(k) {
                                    map.insert(c, hex_to_string(s));
                                }
                            }
                        }
                    }
                    i = next;
                } else {
                    i += 1;
                }
            }
            i += b"endbfrange".len();
        } else {
            i += 1;
        }
    }
    map
}

enum RangeDst {
    /// Either a base string or a list of strings.
    Single(String),
    List(Vec<String>),
}

/// Skips whitespace and returns position of the next non-space byte.
fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] == b' ' || b[i] == b'\n' || b[i] == b'\r' || b[i] == b'\t') {
        i += 1;
    }
    i
}

/// Reads a `<...>` hex string starting at `i` (must point at '<').
fn read_hex(b: &[u8], i: usize) -> Option<(String, usize)> {
    if i >= b.len() || b[i] != b'<' {
        return None;
    }
    let j = b[i..].iter().position(|&c| c == b'>')? + i;
    let s: String = String::from_utf8_lossy(&b[i + 1..j]).chars().filter(|c| c.is_ascii_hexdigit()).collect();
    Some((s, j + 1))
}

fn parse_bf_entry(b: &[u8], i: usize) -> Option<(u32, String, usize)> {
    let i = skip_ws(b, i);
    let (src, i) = read_hex(b, i)?;
    let i = skip_ws(b, i);
    let (dst, i) = read_hex(b, i)?;
    Some((hex_to_u32(&src), hex_to_string(&dst), i))
}

fn parse_bfrange_entry(b: &[u8], i: usize) -> Option<(u32, u32, RangeDst, usize)> {
    let mut i = skip_ws(b, i);
    let (lo_s, i2) = read_hex(b, i)?;
    i = skip_ws(b, i2);
    let (hi_s, i2) = read_hex(b, i)?;
    i = skip_ws(b, i2);
    if i < b.len() && b[i] == b'[' {
        // list form
        let mut list = Vec::new();
        let mut j = i + 1;
        loop {
            j = skip_ws(b, j);
            if j >= b.len() {
                return None;
            }
            if b[j] == b']' {
                break;
            }
            let (s, j2) = read_hex(b, j)?;
            list.push(s);
            j = j2;
        }
        Some((hex_to_u32(&lo_s), hex_to_u32(&hi_s), RangeDst::List(list), j + 1))
    } else {
        let (dst, i2) = read_hex(b, i)?;
        Some((hex_to_u32(&lo_s), hex_to_u32(&hi_s), RangeDst::Single(dst), i2))
    }
}

fn hex_to_u32(s: &str) -> u32 {
    u32::from_str_radix(&s[..s.len().min(8)], 16).unwrap_or(0)
}

fn hex_to_string(s: &str) -> String {
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .filter_map(|k| u8::from_str_radix(&s[k..k + 2], 16).ok())
        .collect();
    decode_utf16be(&bytes)
}

fn utf16be_decode(v: u32) -> String {
    if v <= 0xFFFF {
        decode_utf16be(&[(v >> 8) as u8, (v & 0xFF) as u8])
    } else {
        // 32-bit destination (rare)
        decode_utf16be(&[(v >> 24) as u8, (v >> 16) as u8, (v >> 8) as u8, (v & 0xFF) as u8])
    }
}

fn decode_utf16be(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

// --------------------------------------------------------------------------
// Standard encodings (byte -> unicode)
// --------------------------------------------------------------------------

pub fn std_char(b: u8) -> String {
    // StandardEncoding — mostly ASCII with a few TeX-flavoured slots.
    match b {
        0x27 => "\u{2019}".into(), // quoteright
        0x60 => "\u{2018}".into(), // quoteleft
        0xAD => "-".into(),
        _ => {
            if (0x20..0x7F).contains(&b) {
                (b as char).to_string()
            } else {
                String::new()
            }
        }
    }
}

pub fn win_ansi(b: u8) -> String {
    let s = match b {
        0x80 => "\u{20AC}", 0x82 => "\u{201A}", 0x83 => "\u{0192}", 0x84 => "\u{201E}",
        0x85 => "\u{2026}", 0x86 => "\u{2020}", 0x87 => "\u{2021}", 0x88 => "\u{02C6}",
        0x89 => "\u{2030}", 0x8A => "\u{0160}", 0x8B => "\u{2039}", 0x8C => "\u{0152}",
        0x8E => "\u{017D}", 0x91 => "\u{2018}", 0x92 => "\u{2019}", 0x93 => "\u{201C}",
        0x94 => "\u{201D}", 0x95 => "\u{2022}", 0x96 => "\u{2013}", 0x97 => "\u{2014}",
        0x98 => "\u{02DC}", 0x99 => "\u{2122}", 0x9A => "\u{0161}", 0x9B => "\u{203A}",
        0x9C => "\u{0153}", 0x9E => "\u{017E}", 0x9F => "\u{0178}",
        0xAD => "\u{2011}",
        _ => {
            if b >= 0x20 {
                &(b as char).to_string()[..]
            } else {
                ""
            }
        }
    };
    s.to_string()
}

pub fn mac_roman(b: u8) -> String {
    const T: [char; 128] = [
        'Ä','Å','Ç','É','Ñ','Ö','Ü','á','à','â','ä','ã','å','ç','é','è',
        'ê','ë','í','ì','î','ï','ñ','ó','ò','ô','ö','õ','ú','ù','û','ü',
        '†','°','¢','£','§','•','¶','ß','®','©','™','´','¨','≠','Æ','Ø',
        '∞','±','≤','≥','¥','µ','∂','∑','∏','π','∫','ª','º','Ω','æ','ø',
        '¿','¡','¬','√','ƒ','≈','∆','«','»','…','\u{a0}','À','Ã','Õ','Œ','œ',
        '–','—','“','”','‘','’','÷','◊','ÿ','Ÿ','⁄','€','‹','›','ﬁ','ﬂ',
        '‡','·','‚','„','‰','Â','Ê','Á','Ë','È','Í','Î','Ï','Ì','Ó','Ô',
        '\u{f8ff}','Ò','Ú','Û','Ù','ı','ˆ','˜','¯','˘','˙','˚','¸','˝','˛','ˇ',
    ];
    if b >= 0x80 {
        T[(b as usize) - 0x80].to_string()
    } else {
        (b as char).to_string()
    }
}

pub fn pdf_doc(b: u8) -> String {
    let s = match b {
        0x80 => "\u{2018}", 0x81 => "\u{2019}", 0x82 => "\u{201C}", 0x83 => "\u{201D}",
        0x84 => "\u{2022}", 0x85 => "\u{2013}", 0x86 => "\u{2014}",
        _ => "",
    };
    if s.is_empty() && b > 0x7f {
        return win_ansi(b);
    }
    if s.is_empty() {
        return std_char(b);
    }
    s.to_string()
}

/// Adobe Symbol font encoding (subset that matters for math).
pub fn symbol_char(b: u8) -> String {
    let T: &[(u8, &str)] = &[
        (0x20, " "), (0x21, "!"), (0x22, "\u{2200}"), (0x23, "#"), (0x24, "\u{2203}"),
        (0x25, "%"), (0x26, "&"), (0x27, "\u{220B}"), (0x28, "("), (0x29, ")"),
        (0x2A, "\u{2217}"), (0x2B, "+"), (0x2C, ","), (0x2D, "\u{2212}"), (0x2E, "."),
        (0x2F, "/"), (0x30, "0"), (0x31, "1"), (0x32, "2"), (0x33, "3"), (0x34, "4"),
        (0x35, "5"), (0x36, "6"), (0x37, "7"), (0x38, "8"), (0x39, "9"), (0x3A, ":"),
        (0x3B, ";"), (0x3C, "<"), (0x3D, "="), (0x3E, ">"), (0x3F, "?"),
        (0x40, "\u{2245}"), (0x41, "\u{0391}"), (0x42, "\u{0392}"), (0x43, "\u{03A7}"),
        (0x44, "\u{0394}"), (0x45, "\u{0395}"), (0x46, "\u{03A6}"), (0x47, "\u{0393}"),
        (0x48, "\u{0397}"), (0x49, "\u{0399}"), (0x4A, "\u{03D1}"), (0x4B, "\u{039A}"),
        (0x4C, "\u{039B}"), (0x4D, "\u{039C}"), (0x4E, "\u{039D}"), (0x4F, "\u{039F}"),
        (0x50, "\u{03A0}"), (0x51, "\u{0398}"), (0x52, "\u{03A1}"), (0x53, "\u{03A3}"),
        (0x54, "\u{03A4}"), (0x55, "\u{03A5}"), (0x56, "\u{03C2}"), (0x57, "\u{03A9}"),
        (0x58, "\u{039E}"), (0x59, "\u{03A8}"), (0x5A, "\u{0396}"),
        (0x5B, "["), (0x5C, "\u{2234}"), (0x5D, "]"), (0x5E, "\u{22A5}"),
        (0x5F, "\u{2035}"), (0x60, "\u{F8E5}"), (0x61, "\u{03B1}"), (0x62, "\u{03B2}"),
        (0x63, "\u{03C7}"), (0x64, "\u{03B4}"), (0x65, "\u{03B5}"), (0x66, "\u{03C6}"),
        (0x67, "\u{03B3}"), (0x68, "\u{03B7}"), (0x69, "\u{03B9}"), (0x6A, "\u{03D5}"),
        (0x6B, "\u{03BA}"), (0x6C, "\u{03BB}"), (0x6D, "\u{03BC}"), (0x6E, "\u{03BD}"),
        (0x6F, "\u{03BF}"), (0x70, "\u{03C0}"), (0x71, "\u{03B8}"), (0x72, "\u{03C1}"),
        (0x73, "\u{03C3}"), (0x74, "\u{03C4}"), (0x75, "\u{03C5}"), (0x76, "\u{03D6}"),
        (0x77, "\u{03C9}"), (0x78, "\u{03BE}"), (0x79, "\u{03C8}"), (0x7A, "\u{03B6}"),
        (0x7B, "{"), (0x7C, "|"), (0x7D, "}"), (0x7E, "\u{223C}"),
        (0xA0, "\u{20AC}"), (0xA1, "\u{03D2}"), (0xA2, "\u{2032}"), (0xA3, "\u{2264}"),
        (0xA4, "\u{2044}"), (0xA5, "\u{221E}"), (0xA6, "\u{0192}"), (0xA7, "\u{2663}"),
        (0xA8, "\u{2666}"), (0xA9, "\u{2665}"), (0xAA, "\u{2660}"),
        (0xAB, "\u{2194}"), (0xAC, "\u{2190}"), (0xAD, "\u{2191}"), (0xAE, "\u{2192}"),
        (0xAF, "\u{2193}"), (0xB0, "\u{00B0}"), (0xB1, "\u{00B1}"), (0xB2, "\u{2033}"),
        (0xB3, "\u{2265}"), (0xB4, "\u{00D7}"), (0xB5, "\u{221D}"), (0xB6, "\u{2202}"),
        (0xB7, "\u{2022}"), (0xB8, "\u{00F7}"), (0xB9, "\u{2260}"), (0xBA, "\u{2261}"),
        (0xBB, "\u{2248}"), (0xBC, "\u{2026}"), (0xBD, "\u{F8E6}"), (0xBE, "\u{F8E7}"),
        (0xBF, "\u{21B5}"), (0xC0, "\u{2135}"), (0xC1, "\u{2111}"), (0xC2, "\u{211C}"),
        (0xC3, "\u{2118}"), (0xC4, "\u{2297}"), (0xC5, "\u{2295}"), (0xC6, "\u{2205}"),
        (0xC7, "\u{2229}"), (0xC8, "\u{222A}"), (0xC9, "\u{2282}"), (0xCA, "\u{2283}"),
        (0xCB, "\u{2208}"), (0xCC, "\u{2209}"), (0xCD, "\u{2220}"), (0xCE, "\u{2207}"),
        (0xCF, "\u{00AE}"), (0xD0, "\u{00A9}"), (0xD1, "\u{2122}"), (0xD2, "\u{220F}"),
        (0xD3, "\u{221A}"), (0xD4, "\u{22C5}"), (0xD5, "\u{00AC}"), (0xD6, "\u{2227}"),
        (0xD7, "\u{2228}"), (0xD8, "\u{21D4}"), (0xD9, "\u{21D0}"), (0xDA, "\u{21D1}"),
        (0xDB, "\u{21D2}"), (0xDC, "\u{21D3}"), (0xDD, "\u{22CA}"), (0xDE, "\u{2308}"),
        (0xDF, "\u{2309}"), (0xE0, "\u{230A}"), (0xE1, "\u{230B}"), (0xE2, "\u{222B}"),
        (0xE3, "\u{2240}"), (0xE4, "\u{2329}"), (0xE5, "\u{232A}"), (0xE6, "\u{2211}"),
        (0xE7, "\u{220F}"), (0xF6, "\u{221A}"), (0xF7, "\u{221F}"), (0xF8, "\u{2227}"),
        (0xF9, "\u{2228}"), (0xFA, "\u{2229}"), (0xFB, "\u{222A}"), (0xFC, "\u{222B}"),
        (0xFD, "\u{2244}"), (0xFE, "\u{2260}"), (0xFF, "\u{2246}"),
    ];
    for &(k, v) in T.iter() {
        if k == b {
            return v.to_string();
        }
    }
    String::new()
}

pub fn zapf_char(b: u8) -> String {
    // ZapfDingbats — a few useful ones; bullets dominate our use.
    let s = match b {
        0x6C => "\u{25CF}", 0x6E => "\u{2022}", 0x70 => "\u{25AA}", 0x72 => "\u{25AB}",
        0x75 => "\u{2794}", 0x6F => "\u{2751}", 0x33 => "\u{2713}",
        _ => "",
    };
    s.to_string()
}

/// Extra glyph names seen in the wild but missing from the AGL table.
pub fn agl_fallback(name: &str) -> Option<String> {
    let s = match name {
        "space" => " ",
        "minus" => "\u{2212}",
        "multiply" => "\u{00D7}",
        "divide" => "\u{00F7}",
        "plusminus" => "\u{00B1}",
        "periodcentered" => "\u{00B7}",
        "arrowright" => "\u{2192}",
        "arrowleft" => "\u{2190}",
        "arrowup" => "\u{2191}",
        "arrowdown" => "\u{2193}",
        "lessequal" => "\u{2264}",
        "greaterequal" => "\u{2265}",
        "notequal" => "\u{2260}",
        "approxequal" => "\u{2248}",
        "infinity" => "\u{221E}",
        "partialdiff" => "\u{2202}",
        "radical" => "\u{221A}",
        "summation" => "\u{2211}",
        "product" => "\u{220F}",
        "integral" => "\u{222B}",
        "apple" => "\u{F8FF}",
        "bullet" => "\u{2022}",
        "endash" => "\u{2013}",
        "emdash" => "\u{2014}",
        "quotedblleft" => "\u{201C}",
        "quotedblright" => "\u{201D}",
        "quoteleft" => "\u{2018}",
        "quoteright" => "\u{2019}",
        "fi" => "fi",
        "fl" => "fl",
        "ff" => "ff",
        "ffi" => "ffi",
        "ffl" => "ffl",
        "dotlessi" => "\u{0131}",
        "Lslash" => "\u{0141}",
        "lslash" => "\u{0142}",
        "bar" => "|",
        "bardbl" => "\u{2016}",
        "negationslash" => "/",
        "arrowboth" => "\u{2194}",
        "arrowdblboth" => "\u{21D4}",
        "circlemultiply" => "\u{2297}",
        "circleplus" => "\u{2295}",
        "intersection" => "\u{2229}",
        "union" => "\u{222A}",
        "logicaland" => "\u{2227}",
        "logicalor" => "\u{2228}",
        "reflexsubset" => "\u{2286}",
        "reflexsuperset" => "\u{2287}",
        "equivalence" => "\u{2261}",
        "minute" => "\u{2032}",
        "second" => "\u{2033}",
        "lessequal" => "\u{2264}",
        "greaterequal" => "\u{2265}",
        "similar" => "\u{223C}",
        "approxequal" => "\u{2248}",
        "element" => "\u{2208}",
        "notelement" => "\u{2209}",
        "suchthat" => "\u{220B}",
        "orthogonal" => "\u{22A5}",
        "angle" => "\u{2220}",
        "gradient" => "\u{2207}",
        "floorleft" => "\u{230A}",
        "floorright" => "\u{230B}",
        "ceilingleft" => "\u{2308}",
        "ceilingright" => "\u{2309}",
        _ => return None,
    };
    Some(s.to_string())
}
