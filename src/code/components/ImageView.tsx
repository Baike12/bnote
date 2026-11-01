import { useEffect, useMemo, useState } from "react";
import type { OpenFile } from "../store";
import { formatBytes, imageSrc } from "../image";

/**
 * Image preview in the code area.
 *
 * The backend treats bitmaps as binary (the content is an empty string), so
 * this **does not go through the editor**: the original file on disk is
 * handed to an `<img>` directly through the asset protocol, scaled
 * proportionally to the panel. The save command is a no-op for binary files,
 * so an image is never written as empty text.
 */
export function ImageView({ root, file }: { root: string; file: OpenFile }) {
  const src = useMemo(() => imageSrc(root, file.path), [root, file.path]);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Switching to another file clears the dimensions / failed state of the
  // previous one: otherwise the caption keeps the old dimensions until the
  // new image has loaded, and a load failure wrongly inherits the "healthy"
  // state of the previous one.
  useEffect(() => {
    setDimensions(null);
    setFailed(false);
  }, [src]);

  return (
    <div className="code-image-view">
      <div className="code-image-stage">
        {src && !failed && (
          <img
            className="code-image"
            src={src}
            alt={file.path}
            onLoad={(event) => {
              const img = event.currentTarget;
              setDimensions(`${img.naturalWidth} × ${img.naturalHeight}`);
            }}
            onError={() => setFailed(true)}
          />
        )}
        {failed && <div className="code-image-error">这张图片无法显示</div>}
      </div>
      <div className="code-image-caption">
        <span className="code-image-name" title={file.path}>
          {file.path}
        </span>
        <span className="code-image-meta">
          {dimensions ? `${dimensions} · ` : ""}
          {formatBytes(file.size)}
        </span>
      </div>
    </div>
  );
}
