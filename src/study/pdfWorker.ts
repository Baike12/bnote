// Dedicated pdf.js worker entry.
//
// The worker global needs the same Iterator shim as the window (see
// pdfjsCompat.ts): the worker module probes `Iterator.prototype.join` at
// startup, and a missing Iterator there keeps the document from ever loading.
import "./pdfjsCompat";
import "pdfjs-dist/build/pdf.worker.min.mjs";
