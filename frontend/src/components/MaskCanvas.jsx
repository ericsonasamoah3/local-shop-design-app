import { useRef, useState, useEffect } from 'react';

// Lets the user drag a rough rectangle over their uploaded photo to mark
// where the selected item should be composited in. Phase 2 uses manual
// placement rather than auto-detection — see CLAUDE.md for why.
//
// Produces a black/white mask PNG (white = area to fill) as a base64 data
// URI, matching the uploaded photo's natural dimensions, since that's what
// the inpainting model needs.

export default function MaskCanvas({ imageUrl, onMaskReady }) {
  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [box, setBox] = useState(null); // { x, y, w, h } in displayed-canvas coordinates
  const [naturalSize, setNaturalSize] = useState(null);

  function handleImageLoad() {
    const img = imgRef.current;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
  }

  function getCanvasPoint(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function handlePointerDown(e) {
    const point = getCanvasPoint(e);
    setDrawing(true);
    setBox({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  function handlePointerMove(e) {
    if (!drawing) return;
    const point = getCanvasPoint(e);
    setBox((prev) => ({ ...prev, w: point.x - prev.x, h: point.y - prev.y }));
  }

  function handlePointerUp() {
    setDrawing(false);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#c98a2e';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = 'rgba(201, 138, 46, 0.2)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }, [box]);

  function confirmMask() {
    if (!box || !naturalSize || !canvasRef.current) return;

    const displayRect = canvasRef.current.getBoundingClientRect();
    const scaleX = naturalSize.width / displayRect.width;
    const scaleY = naturalSize.height / displayRect.height;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = naturalSize.width;
    maskCanvas.height = naturalSize.height;
    const ctx = maskCanvas.getContext('2d');

    // Black background = "don't touch this", white box = "fill this in".
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx.fillStyle = '#ffffff';

    const normX = Math.min(box.x, box.x + box.w) * scaleX;
    const normY = Math.min(box.y, box.y + box.h) * scaleY;
    const normW = Math.abs(box.w) * scaleX;
    const normH = Math.abs(box.h) * scaleY;
    ctx.fillRect(normX, normY, normW, normH);

    onMaskReady(maskCanvas.toDataURL('image/png'));
  }

  const hasValidBox = box && Math.abs(box.w) > 10 && Math.abs(box.h) > 10;

  return (
    <div className="mask-canvas-wrap">
      <p className="mask-canvas__hint">Drag a box over where this item should go</p>
      <div className="mask-canvas__stage">
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Your uploaded space"
          onLoad={handleImageLoad}
          className="mask-canvas__image"
        />
        <canvas
          ref={canvasRef}
          className="mask-canvas__overlay"
          width={480}
          height={480}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
        />
      </div>
      <button className="btn" onClick={confirmMask} disabled={!hasValidBox}>
        Use this area
      </button>
    </div>
  );
}
