/**
 * The annotation tools the PDF page accepts.
 *
 * Only the highlight survived: the text annotation moved to the notes column,
 * and the page no longer reserves a gutter for annotation cards. The note
 * entries of old files stay on disk untouched, they are simply no longer
 * created and no longer rendered.
 */
export type PdfTool = "highlight";
