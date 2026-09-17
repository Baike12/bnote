//! Geometry primitives: 2D affine transforms and axis-aligned rects.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Mat {
    pub const IDENTITY: Mat = Mat { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    /// Matrix product `self * other` — applies `other` first, then `self`
    /// (PDF content-stream semantics: `cm` concatenates CTM = cm × CTM).
    /// Affine layout: x' = a x + c y + e; y' = b x + d y + f.
    pub fn mul(&self, o: &Mat) -> Mat {
        Mat {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            e: self.a * o.e + self.c * o.f + self.e,
            f: self.b * o.e + self.d * o.f + self.f,
        }
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }

    /// Average scale factor (for line widths etc.).
    pub fn scale(&self) -> f64 {
        ((self.a * self.d - self.b * self.c).abs()).sqrt().max(1e-9)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn empty() -> Rect {
        Rect { x0: f64::MAX, y0: f64::MAX, x1: f64::MIN, y1: f64::MIN }
    }

    pub fn is_empty(&self) -> bool {
        self.x0 > self.x1 || self.y0 > self.y1
    }

    pub fn from_points(pts: &[(f64, f64)]) -> Rect {
        let mut r = Rect::empty();
        for &(x, y) in pts {
            r.add(x, y);
        }
        r
    }

    pub fn add(&mut self, x: f64, y: f64) {
        self.x0 = self.x0.min(x);
        self.y0 = self.y0.min(y);
        self.x1 = self.x1.max(x);
        self.y1 = self.y1.max(y);
    }

    pub fn union(&mut self, o: &Rect) {
        if o.is_empty() {
            return;
        }
        self.x0 = self.x0.min(o.x0);
        self.y0 = self.y0.min(o.y0);
        self.x1 = self.x1.max(o.x1);
        self.y1 = self.y1.max(o.y1);
    }

    pub fn width(&self) -> f64 {
        (self.x1 - self.x0).max(0.0)
    }

    pub fn height(&self) -> f64 {
        (self.y1 - self.y0).max(0.0)
    }

    pub fn intersect_area(&self, o: &Rect) -> f64 {
        let w = (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0);
        let h = (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0);
        w * h
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x0 && x <= self.x1 && y >= self.y0 && y <= self.y1
    }

    /// True when `o` lies (mostly) inside this rect.
    pub fn contains_rect(&self, o: &Rect) -> bool {
        o.x0 >= self.x0 - 1.0 && o.x1 <= self.x1 + 1.0 && o.y0 >= self.y0 - 1.0 && o.y1 <= self.y1 + 1.0
    }

    /// Vertical overlap of [y0,y1] intervals.
    pub fn y_overlap(&self, o: &Rect) -> f64 {
        (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0)
    }

    pub fn center(&self) -> (f64, f64) {
        ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)
    }
}
