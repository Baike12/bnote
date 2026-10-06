//! Scan cost gates.
//!
//! The workspace scans the whole document on every change (the engine has no
//! visible-range query yet), so the cost per change has to stay far below a
//! frame, and — more importantly — the scan must stay **linear** in the
//! document length. A per-line walk over every math region (or over any other
//! per-document list) is quadratic and shows up here as a 10x document taking
//! ~100x the time.
//!
//! The bounds are deliberately loose: this is a magnitude gate for debug
//! builds on a shared machine, not a benchmark.

use std::ops::Range;
use std::time::Instant;

use super::{scan, ScanInput};

/// A document with every construct the scanner knows, repeated to `target`
/// bytes.
fn document(target: usize) -> String {
    let section = "\
# Heading with **bold** and *italic* and `code`\n\
\n\
A paragraph with a $x^2 + y^2 = z^2$ formula, a [link](https://example.com),\n\
a [[wiki link|alias]] and an ![[image.png]] embed.\n\
\n\
- [ ] a todo item\n\
- [x] a done item\n\
  - nested with _emphasis_\n\
\n\
> a quote line\n\
> > and a deeper one\n\
\n\
```rust\n\
fn main() { println!(\"hi\"); }\n\
```\n\
\n\
::: note A callout title\n\
Body text inside the callout.\n\
:::\n\
\n\
$$\n\
\\frac{a}{b} = c\n\
$$\n\
\n\
---\n\
\n";
    let mut text = String::with_capacity(target + section.len());
    while text.len() < target {
        text.push_str(section);
    }
    text
}

fn median_scan_micros(text: &str) -> u128 {
    let cursor: Range<usize> = 0..0;
    let input = || ScanInput {
        text,
        selections: std::slice::from_ref(&cursor),
        visible: 0..usize::MAX,
    };
    let _ = scan(input());
    let mut timings: Vec<u128> = (0..5)
        .map(|_| {
            let start = Instant::now();
            let snapshot = scan(input());
            let elapsed = start.elapsed().as_micros();
            assert!(!snapshot.spans.is_empty());
            elapsed
        })
        .collect();
    timings.sort_unstable();
    timings[timings.len() / 2]
}

#[test]
fn whole_document_scan_is_linear_and_cheap() {
    let small = document(7_000);
    let large = document(70_000);
    let small_us = median_scan_micros(&small);
    let large_us = median_scan_micros(&large);
    println!(
        "scan: {} bytes {} µs, {} bytes {} µs",
        small.len(),
        small_us,
        large.len(),
        large_us
    );

    // A 10x document costs ~10x; the slack covers allocator and scheduler
    // noise. Quadratic behaviour would be ~100x and fail this outright.
    let ratio = large_us as f64 / small_us.max(1) as f64;
    assert!(
        ratio < 25.,
        "scan cost must scale with the document, 10x bytes took {ratio:.1}x time \
         ({small_us} µs → {large_us} µs)"
    );

    // Absolute ceiling for a 70 KB note in a debug build (release is ~10x
    // faster). A frame is 16 ms; a keystroke scan must not get close.
    assert!(large_us < 30_000, "scanning a 70 KB note took {large_us} µs");
}
