/** The DevTools box-model diagram: margin / border / padding / content. */
import type { BoxModel } from '@bxconsole/protocol';

export function BoxModelView({ box }: { box: BoxModel }) {
  const n = (v: number) => (v === 0 ? '-' : String(v));
  return (
    <div className="boxmodel">
      <div className="boxmodel-layer margin">
        <span className="boxmodel-label">margin</span>
        <span className="boxmodel-top">{n(box.margin[0])}</span>
        <span className="boxmodel-right">{n(box.margin[1])}</span>
        <span className="boxmodel-bottom">{n(box.margin[2])}</span>
        <span className="boxmodel-left">{n(box.margin[3])}</span>
        <div className="boxmodel-layer border">
          <span className="boxmodel-label">border</span>
          <span className="boxmodel-top">{n(box.border[0])}</span>
          <span className="boxmodel-right">{n(box.border[1])}</span>
          <span className="boxmodel-bottom">{n(box.border[2])}</span>
          <span className="boxmodel-left">{n(box.border[3])}</span>
          <div className="boxmodel-layer padding">
            <span className="boxmodel-label">padding</span>
            <span className="boxmodel-top">{n(box.padding[0])}</span>
            <span className="boxmodel-right">{n(box.padding[1])}</span>
            <span className="boxmodel-bottom">{n(box.padding[2])}</span>
            <span className="boxmodel-left">{n(box.padding[3])}</span>
            <div className="boxmodel-layer content">
              {box.width} × {box.height}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
