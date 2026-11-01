import { useEffect, useMemo, useState } from "react";
import type { OpenFile } from "../store";
import { formatBytes, imageSrc } from "../image";

/**
 * 代码区里的图片预览。
 *
 * 后端把位图当二进制(内容为空串),所以这里**不经过编辑器**:直接用
 * asset 协议把磁盘上的原文件交给 `<img>`,按面板大小等比缩放显示。
 * 保存命令对二进制文件是空操作,不会把图片写成空文本。
 */
export function ImageView({ root, file }: { root: string; file: OpenFile }) {
  const src = useMemo(() => imageSrc(root, file.path), [root, file.path]);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // 换一个文件就把上一张的尺寸/失败态清掉:不然新图加载完之前会顶着旧图的
  // 角注,加载失败也会错误地沿用上一张的「正常」状态。
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
