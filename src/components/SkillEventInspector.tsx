import { Grid3X3, Images, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { uid } from "../model";
import type { AssetRef, TimelineEvent, TimelineTrack, UnityPropertyCatalogEntry } from "../types";
import DeferredTextInput from "./DeferredTextInput";
import NumericInput from "./NumericInput";

interface Props {
  event: TimelineEvent;
  track: TimelineTrack;
  tickRate: number;
  defaultPixelsPerUnit: number;
  assets: Record<string, AssetRef>;
  propertyCatalog: UnityPropertyCatalogEntry[];
  propertyCatalogMessage: string;
  onUpdate: (patch: Partial<TimelineEvent>) => void;
  onCreateAssets: (files: File[], kind: "image" | "audio") => Promise<string[]>;
  onDelete: () => void;
}

function numeric(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function NumberField({ label, value, onChange, min, max, step = 1, integer = false, title }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  title?: string;
}) {
  return <label className="field" title={title}><span>{label}</span><NumericInput value={value} min={min} max={max} step={step} integer={integer} onValueChange={onChange} /></label>;
}

function SelectField({ label, value, options, onChange, title }: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  title?: string;
}) {
  return <label className="field" title={title}><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function EffectHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return <div className="effect-list-heading"><strong>{title}</strong><button type="button" title={`添加${title}`} onClick={onAdd}><Plus size={14} /></button></div>;
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="effect-remove" title="删除此项" onClick={onClick}><Trash2 size={14} /></button>;
}

function PropertyField({ label, value, catalog, onChange }: {
  label: string;
  value: string;
  catalog: UnityPropertyCatalogEntry[];
  onChange: (value: string) => void;
}) {
  const groups = catalog.reduce<Record<string, UnityPropertyCatalogEntry[]>>((result, item) => {
    const category = item.category || "其他";
    (result[category] ||= []).push(item);
    return result;
  }, {});
  const known = catalog.some((item) => item.id === value);
  return <label className="field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">请选择 Unity 属性</option>
      {value && !known && <option value={value}>{value}（目录中不存在）</option>}
      {Object.entries(groups).map(([category, entries]) => <optgroup key={category} label={category}>
        {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName} · {entry.id}</option>)}
      </optgroup>)}
    </select>
  </label>;
}

const defaultAttributeReference = (nested: boolean) => ({
  id: uid("reference"),
  propertyId: "",
  percent: 0,
  ...(nested ? { referenceObject: "self" } : {}),
});

const defaultAttributeEffect = (nested: boolean) => ({
  id: uid("attribute"),
  propertyId: "",
  fixedValue: 0,
  references: [],
  changeType: "permanent",
  durationSeconds: 0,
  ...(nested ? { targetObject: "target" } : {}),
});

function AttributeEffects({ title, values, onChange, propertyCatalog, propertyCatalogMessage, nested }: {
  title: string;
  values: any[];
  onChange: (values: any[]) => void;
  propertyCatalog: UnityPropertyCatalogEntry[];
  propertyCatalogMessage: string;
  nested: boolean;
}) {
  const propertyName = (propertyId: string) => propertyCatalog.find((item) => item.id === propertyId)?.displayName || propertyId || "未选择属性";
  return <div className="nested-effect-list attribute-effect-list">
    <EffectHeader title={title} onAdd={() => onChange([...values, defaultAttributeEffect(nested)])} />
    {!propertyCatalog.length && <div className="time-readout">{propertyCatalogMessage || "Unity 尚未提供可修改属性目录。"}</div>}
    {values.map((effect, index) => {
      const patch = (next: any) => onChange(values.map((item, cursor) => cursor === index ? { ...item, ...next } : item));
      const references = Array.isArray(effect.references) ? effect.references : [];
      const selectedProperty = propertyCatalog.find((item) => item.id === effect.propertyId);
      const temporary = effect.changeType === "temporary";
      const unsupportedChangeType = selectedProperty && (temporary ? !selectedProperty.allowTemporary : !selectedProperty.allowPermanent);
      const selectTargetProperty = (propertyId: string) => {
        const property = propertyCatalog.find((item) => item.id === propertyId);
        if (!property) {
          patch({ propertyId });
        } else if (temporary && !property.allowTemporary && property.allowPermanent) {
          patch({ propertyId, changeType: "permanent", durationSeconds: 0 });
        } else if (!temporary && !property.allowPermanent && property.allowTemporary) {
          patch({ propertyId, changeType: "temporary", durationSeconds: Math.max(1, numeric(effect.durationSeconds)) });
        } else {
          patch({ propertyId });
        }
      };
      return <details className="effect-block" key={effect.id || index} open={index === 0}>
        <summary><span>{index + 1}. {propertyName(effect.propertyId)}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
        <div className="effect-block-body">
          {nested && <SelectField label="作用对象" value={effect.targetObject === "self" ? "self" : "target"} onChange={(value) => patch({ targetObject: value })} options={[["self", "自身"], ["target", "目标"]]} />}
          <PropertyField label="目标属性" value={effect.propertyId || ""} catalog={propertyCatalog} onChange={selectTargetProperty} />
          <div className="field-grid two-columns">
            <NumberField label="固定值" title="最终改变量会叠加固定值和全部参考属性百分比结果，可填写负数" value={numeric(effect.fixedValue)} step={0.1} onChange={(fixedValue) => patch({ fixedValue })} />
            <SelectField label="改变方式" value={temporary ? "temporary" : "permanent"} onChange={(changeType) => patch(changeType === "temporary"
              ? { changeType, durationSeconds: Math.max(1, numeric(effect.durationSeconds)) }
              : { changeType, durationSeconds: 0 })} options={[["temporary", "临时修正"], ["permanent", "永久变化"]]} />
            {temporary && <NumberField label="持续时间（秒）" value={numeric(effect.durationSeconds)} min={0.01} step={0.1} onChange={(durationSeconds) => patch({ durationSeconds: Math.max(0.01, durationSeconds) })} />}
          </div>
          {unsupportedChangeType && <div className="time-readout">当前 Unity 属性不支持所选改变方式，请切换方式或目标属性。</div>}

          <div className="nested-effect-list attribute-reference-list">
            <EffectHeader title="参考属性" onAdd={() => patch({ references: [...references, defaultAttributeReference(nested)] })} />
            {!references.length && <div className="time-readout">最终改变量 = 固定值；添加参考属性后会继续累加“参考值 × 百分比”。</div>}
            {references.map((reference: any, referenceIndex: number) => {
              const patchReference = (next: any) => {
                const nextReferences = structuredClone(references);
                nextReferences[referenceIndex] = { ...nextReferences[referenceIndex], ...next };
                patch({ references: nextReferences });
              };
              return <div className="attribute-reference-row" key={reference.id || referenceIndex}>
                {nested && <SelectField label="参考对象" value={reference.referenceObject === "target" ? "target" : "self"} onChange={(referenceObject) => patchReference({ referenceObject })} options={[["self", "自身"], ["target", "目标"]]} />}
                <PropertyField label="参考属性" value={reference.propertyId || ""} catalog={propertyCatalog} onChange={(propertyId) => patchReference({ propertyId })} />
                <NumberField label="参考百分比" title="100 表示取参考属性的 100%，可填写负数" value={numeric(reference.percent)} step={1} onChange={(percent) => patchReference({ percent })} />
                <RemoveButton onClick={() => patch({ references: references.filter((_: any, cursor: number) => cursor !== referenceIndex) })} />
              </div>;
            })}
          </div>
        </div>
      </details>;
    })}
  </div>;
}

const PHYSICS_LABELS: Record<string, string> = {
  knockback: "击退",
  pull: "拉拽",
  launch: "击飞",
  dashSelf: "位移",
  teleportSelf: "瞬移",
  stun: "眩晕",
  airborne: "腾空",
  hover: "滞空",
  superArmor: "霸体",
  invincible: "无敌",
};

const TOP_LEVEL_PHYSICS = ["dashSelf", "teleportSelf", "airborne", "hover", "superArmor", "invincible"];
const ON_HIT_PHYSICS = ["knockback", "pull", "launch", "hover", "stun"];

const defaultPhysics = (scope: "topLevel" | "onHit") => ({
  effectType: scope === "topLevel" ? "dashSelf" : "knockback",
  delayTicks: 0,
  distance: 1,
  height: 0,
  durationMode: "fixed",
  durationTicks: 0,
});

const defaultMotion = () => ({
  enabled: false,
  mode: "linear",
  speed: 0,
  directionX: 1,
  directionY: 0,
  durationTicks: 180,
  controlAX: 0.4,
  controlAY: 0.2,
  controlBX: 0.8,
  controlBY: 0.2,
  endX: 1.2,
  endY: 0,
  retargetOnDescendingPath: false,
  pathProgressCurve: [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }],
});

const defaultVfx = (pixelsPerUnit = 160) => ({
  assetId: "",
  frameAssetIds: [],
  fps: 12,
  pixelsPerUnit: Math.max(1, pixelsPerUnit),
  pivotX: 0.5,
  pivotY: 0.5,
  renderLayer: "front",
  loop: false,
  anchor: "caster",
  useFollowDuration: false,
  followDurationTicks: 0,
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  triggerDelayTicks: 0,
  motion: defaultMotion(),
  destroyMode: "natural",
  durationTicks: 0,
});

const defaultSfx = () => ({
  assetId: "",
  anchor: "caster",
  x: 0,
  y: 0,
  triggerDelayTicks: 0,
  loop: false,
  destroyMode: "natural",
  durationTicks: 0,
});

interface VfxSheetState {
  file: File;
  url: string;
  width: number;
  height: number;
  columns: number;
  frameCount: number;
  spacing: number;
  padding: number;
  cellWidth: number;
  cellHeight: number;
}

function vfxFrameIds(effect: any): string[] {
  const ids = Array.isArray(effect.frameAssetIds) ? effect.frameAssetIds.filter((id: unknown) => typeof id === "string" && id) : [];
  if (!ids.length && effect.assetId) ids.push(effect.assetId);
  return ids;
}

function vfxResourceLabel(effect: any, assets: Record<string, AssetRef>): string {
  const ids = vfxFrameIds(effect);
  if (!ids.length) return "未绑定特效序列";
  const firstName = assets[ids[0]]?.name || "特效序列";
  return ids.length === 1 ? `${firstName} · 单帧` : `${firstName} · ${ids.length} 帧`;
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = url;
  });
}

function sheetLayout(value: VfxSheetState) {
  const columns = Math.max(1, Math.round(value.columns));
  const frameCount = Math.max(1, Math.round(value.frameCount));
  const rows = Math.ceil(frameCount / columns);
  const spacing = Math.max(0, Math.round(value.spacing));
  const padding = Math.max(0, Math.round(value.padding));
  const cellWidth = Math.max(1, Math.round(value.cellWidth));
  const cellHeight = Math.max(1, Math.round(value.cellHeight));
  const requiredWidth = padding * 2 + columns * cellWidth + Math.max(0, columns - 1) * spacing;
  const requiredHeight = padding * 2 + rows * cellHeight + Math.max(0, rows - 1) * spacing;
  return { columns, frameCount, rows, spacing, padding, cellWidth, cellHeight, requiredWidth, requiredHeight, fits: requiredWidth <= value.width && requiredHeight <= value.height };
}

function VfxResourceEditor({ effect, assets, onChange, onCreateAssets, defaultPixelsPerUnit }: {
  effect: any;
  assets: Record<string, AssetRef>;
  onChange: (patch: any) => void;
  onCreateAssets: Props["onCreateAssets"];
  defaultPixelsPerUnit: number;
}) {
  const [sheet, setSheet] = useState<VfxSheetState | null>(null);
  const layout = sheet ? sheetLayout(sheet) : null;

  const bindFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    const ids = await onCreateAssets(images, "image");
    onChange({ frameAssetIds: ids, assetId: ids[0] || "" });
  };

  const prepareSheet = async (file: File) => {
    const url = URL.createObjectURL(file);
    const size = await readImageSize(url);
    const columns = 4;
    const frameCount = 4;
    setSheet({ file, url, ...size, columns, frameCount, spacing: 0, padding: 0, cellWidth: Math.max(1, Math.floor(size.width / columns)), cellHeight: size.height });
  };

  const splitSheet = async () => {
    if (!sheet || !layout?.fits) return;
    const image = new Image();
    image.src = sheet.url;
    await image.decode();
    const files: File[] = [];
    for (let index = 0; index < layout.frameCount; index += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = layout.cellWidth;
      canvas.height = layout.cellHeight;
      const context = canvas.getContext("2d")!;
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      context.drawImage(image, layout.padding + column * (layout.cellWidth + layout.spacing), layout.padding + row * (layout.cellHeight + layout.spacing), layout.cellWidth, layout.cellHeight, 0, 0, layout.cellWidth, layout.cellHeight);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      files.push(new File([blob], `${sheet.file.name.replace(/\.[^.]+$/, "")}_${String(index + 1).padStart(3, "0")}.png`, { type: "image/png" }));
    }
    await bindFiles(files);
    URL.revokeObjectURL(sheet.url);
    setSheet(null);
  };

  return <>
    <div className="vfx-resource-actions">
      <label className="asset-bind-button"><input type="file" accept="image/*" multiple onChange={async (event) => { const input = event.currentTarget; await bindFiles(Array.from(input.files || [])); input.value = ""; }} /><Images size={14} />导入 PNG 序列</label>
      <label className="asset-bind-button"><input type="file" accept="image/*" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) await prepareSheet(file); input.value = ""; }} /><Grid3X3 size={14} />拆分 Sprite Sheet</label>
    </div>
    <div className="time-readout">{vfxResourceLabel(effect, assets)}</div>
    <div className="field-grid two-columns">
      <NumberField label="播放 FPS" value={numeric(effect.fps, 12)} min={1} onChange={(value) => onChange({ fps: Math.max(1, value) })} />
      <NumberField label="特效 PPU" title="每个特效独立生效；数值越大，特效在世界中的基础尺寸越小" value={numeric(effect.pixelsPerUnit, defaultPixelsPerUnit)} min={1} step={1} onChange={(value) => onChange({ pixelsPerUnit: Math.max(1, value) })} />
    </div>
    {(() => {
      const firstAsset = assets[vfxFrameIds(effect)[0]];
      const ppu = Math.max(1, numeric(effect.pixelsPerUnit, defaultPixelsPerUnit));
      return firstAsset?.width && firstAsset?.height
        ? <div className="time-readout">单帧基础尺寸 {(firstAsset.width / ppu).toFixed(2)} × {(firstAsset.height / ppu).toFixed(2)} Unity 单位</div>
        : null;
    })()}
    {sheet && layout && <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="拆分特效 Sprite Sheet">
        <div className="modal-heading"><div><strong>拆分特效 Sprite Sheet</strong><span>原图只读，拆分结果作为特效序列帧</span></div></div>
        <img className="sheet-preview" src={sheet.url} alt="特效 Sprite Sheet 预览" />
        <div className="field-grid two-columns">
          <NumberField label="帧数" value={sheet.frameCount} min={1} integer onChange={(value) => setSheet({ ...sheet, frameCount: Math.max(1, Math.round(value)) })} />
          <NumberField label="Sheet 列数" value={sheet.columns} min={1} integer onChange={(value) => setSheet({ ...sheet, columns: Math.max(1, Math.round(value)) })} />
          <NumberField label="Sheet 间距" value={sheet.spacing} min={0} integer onChange={(value) => setSheet({ ...sheet, spacing: Math.max(0, Math.round(value)) })} />
          <NumberField label="Sheet 边距" value={sheet.padding} min={0} integer onChange={(value) => setSheet({ ...sheet, padding: Math.max(0, Math.round(value)) })} />
          <NumberField label="格宽" value={sheet.cellWidth} min={1} integer onChange={(value) => setSheet({ ...sheet, cellWidth: Math.max(1, Math.round(value)) })} />
          <NumberField label="格高" value={sheet.cellHeight} min={1} integer onChange={(value) => setSheet({ ...sheet, cellHeight: Math.max(1, Math.round(value)) })} />
        </div>
        <div className={`sheet-layout-status${layout.fits ? "" : " error"}`}><span>布局占用 {layout.requiredWidth}×{layout.requiredHeight} 像素 · {layout.rows} 行</span>{!layout.fits && <strong>当前参数超出原图范围</strong>}</div>
        <div className="modal-actions"><button type="button" onClick={() => { URL.revokeObjectURL(sheet.url); setSheet(null); }}>取消</button><button type="button" className="primary-button" disabled={!layout.fits} onClick={() => void splitSheet()}>拆分并绑定特效</button></div>
      </div>
    </div>}
  </>;
}

function PhysicsEffects({ values, onChange, scope, title = "物理效果" }: {
  values: any[];
  onChange: (values: any[]) => void;
  scope: "topLevel" | "onHit";
  title?: string;
}) {
  const allowedTypes = scope === "topLevel" ? TOP_LEVEL_PHYSICS : ON_HIT_PHYSICS;
  const patch = (index: number, next: any) => onChange(values.map((item, cursor) => cursor === index ? { ...item, ...next } : item));
  return <div className="nested-effect-list">
    <EffectHeader title={title} onAdd={() => onChange([...values, defaultPhysics(scope)])} />
    {values.map((effect, index) => {
      const effectType = allowedTypes.includes(effect.effectType) ? effect.effectType : allowedTypes[0];
      const isTeleport = effectType === "teleportSelf";
      const usesDistance = ["knockback", "pull", "launch", "dashSelf", "teleportSelf"].includes(effectType);
      const usesHeight = ["launch", "airborne"].includes(effectType);
      const supportsUntilActionEnd = ["superArmor", "invincible"].includes(effectType);
      const durationMode = supportsUntilActionEnd ? effect.durationMode || "fixed" : "fixed";
      return <details className="effect-block" key={index} open={index === 0}>
        <summary><span>{index + 1}. {PHYSICS_LABELS[effectType]}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
        <div className="effect-block-body">
          <SelectField
            label="效果类型"
            value={effectType}
            onChange={(value) => {
              const height = ["launch", "airborne"].includes(value) ? Math.max(0.1, numeric(effect.height) || 1) : 0;
              const durationTicks = value === "hover" ? Math.max(1, numeric(effect.durationTicks) || 60) : numeric(effect.durationTicks);
              patch(index, value === "teleportSelf"
                ? { effectType: value, height, anchor: effect.anchor === "target" ? "target" : "self", durationMode: "fixed", durationTicks: 0 }
                : ["superArmor", "invincible"].includes(value) ? { effectType: value, height } : { effectType: value, height, durationTicks, durationMode: "fixed" });
            }}
            options={allowedTypes.map((value) => [value, PHYSICS_LABELS[value]])}
          />
          {isTeleport && <SelectField
            label="锚点"
            value={effect.anchor === "target" ? "target" : "self"}
            onChange={(value) => patch(index, { anchor: value })}
            options={[["self", "自身"], ["target", "当前目标"]]}
            title="以锚点朝向为正方向：正数在前方，负数在后方"
          />}
          <div className="field-grid two-columns">
            {scope === "onHit" && <NumberField label="生效延迟 Tick" value={numeric(effect.delayTicks)} min={0} integer onChange={(value) => patch(index, { delayTicks: value })} />}
            {usesDistance && <NumberField label="距离" value={numeric(effect.distance)} min={isTeleport ? undefined : 0} step={0.1} onChange={(value) => patch(index, { distance: value })} title={isTeleport ? "0 为锚点位置；正数为锚点前方，负数为锚点后方" : undefined} />}
            {usesHeight && <NumberField label="高度" value={numeric(effect.height)} min={0} step={0.1} onChange={(value) => patch(index, { height: value })} />}
            {!isTeleport && durationMode === "fixed" && <NumberField label="持续 Tick" value={numeric(effect.durationTicks)} min={effectType === "hover" ? 1 : 0} integer onChange={(value) => patch(index, { durationTicks: Math.max(effectType === "hover" ? 1 : 0, value) })} />}
          </div>
          {isTeleport && <div className="time-readout">落点会自动进行地面贴合、墙体阻挡、碰撞修正和速度清理。</div>}
          {supportsUntilActionEnd && <SelectField label="持续方式" value={durationMode} onChange={(value) => patch(index, { durationMode: value })} options={[["fixed", "指定时长"], ["untilActionEnd", "动作结束"]]} />}
        </div>
      </details>;
    })}
  </div>;
}

interface ProgressKey {
  time: number;
  value: number;
  tangentMode: "smooth" | "linear" | "flat";
}

const CURVE_PRESETS: Record<string, ProgressKey[]> = {
  linear: [{ time: 0, value: 0, tangentMode: "linear" }, { time: 1, value: 1, tangentMode: "linear" }],
  easeIn: [{ time: 0, value: 0, tangentMode: "flat" }, { time: 1, value: 1, tangentMode: "smooth" }],
  easeOut: [{ time: 0, value: 0, tangentMode: "smooth" }, { time: 1, value: 1, tangentMode: "flat" }],
  easeInOut: [{ time: 0, value: 0, tangentMode: "flat" }, { time: 0.5, value: 0.5, tangentMode: "smooth" }, { time: 1, value: 1, tangentMode: "flat" }],
  return: [{ time: 0, value: 0, tangentMode: "smooth" }, { time: 0.5, value: 1, tangentMode: "flat" }, { time: 1, value: 0, tangentMode: "smooth" }],
};

function normalizeCurveKeys(value: any): ProgressKey[] {
  const keys = Array.isArray(value) ? value.map((item) => ({ time: Math.min(1, Math.max(0, numeric(item?.time))), value: Math.min(1, Math.max(0, numeric(item?.value))), tangentMode: ["smooth", "flat"].includes(item?.tangentMode) ? item.tangentMode : "linear" })) : [];
  if (keys.length < 2) return structuredClone(CURVE_PRESETS.linear);
  return keys.sort((left, right) => left.time - right.time);
}

function evaluateProgressCurve(value: any, time: number): number {
  const keys = normalizeCurveKeys(value);
  const t = Math.min(1, Math.max(0, time));
  if (t <= keys[0].time) return keys[0].value;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (t > right.time) continue;
    const left = keys[index - 1];
    const range = Math.max(0.0001, right.time - left.time);
    const u = (t - left.time) / range;
    const slope = (from: number, to: number) => (keys[to].value - keys[from].value) / Math.max(0.0001, keys[to].time - keys[from].time);
    const tangent = (keyIndex: number, side: "in" | "out") => {
      const key = keys[keyIndex];
      if (key.tangentMode === "flat") return 0;
      const leftSlope = keyIndex > 0 ? slope(keyIndex - 1, keyIndex) : null;
      const rightSlope = keyIndex < keys.length - 1 ? slope(keyIndex, keyIndex + 1) : null;
      if (key.tangentMode === "linear") return side === "in" ? leftSlope ?? rightSlope ?? 0 : rightSlope ?? leftSlope ?? 0;
      return leftSlope !== null && rightSlope !== null ? (leftSlope + rightSlope) * 0.5 : leftSlope ?? rightSlope ?? 0;
    };
    const m0 = tangent(index - 1, "out") * range;
    const m1 = tangent(index, "in") * range;
    const u2 = u * u;
    const u3 = u2 * u;
    return Math.min(1, Math.max(0, (2 * u3 - 3 * u2 + 1) * left.value + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * right.value + (u3 - u2) * m1));
  }
  return keys.at(-1)?.value ?? 1;
}

function ProgressCurveEditor({ value, onChange }: { value: any; onChange: (value: ProgressKey[]) => void }) {
  const keys = normalizeCurveKeys(value);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const width = 260;
  const height = 116;
  const padding = 12;
  const toScreen = (key: Pick<ProgressKey, "time" | "value">) => ({ x: padding + key.time * (width - padding * 2), y: padding + (1 - key.value) * (height - padding * 2) });
  const samples = Array.from({ length: 49 }, (_, index) => {
    const time = index / 48;
    return toScreen({ time, value: evaluateProgressCurve(keys, time) });
  });

  const updateKey = (index: number, next: Partial<ProgressKey>) => {
    const updated = structuredClone(keys);
    const previousTime = index > 0 ? updated[index - 1].time + 0.01 : 0;
    const nextTime = index < updated.length - 1 ? updated[index + 1].time - 0.01 : 1;
    updated[index] = {
      time: index === 0 ? 0 : index === updated.length - 1 ? 1 : Math.min(nextTime, Math.max(previousTime, next.time ?? updated[index].time)),
      value: Math.min(1, Math.max(0, next.value ?? updated[index].value)),
      tangentMode: next.tangentMode ?? updated[index].tangentMode,
    };
    onChange(updated);
  };

  const updateFromPointer = (clientX: number, clientY: number, svg: SVGSVGElement, index: number) => {
    const rect = svg.getBoundingClientRect();
    updateKey(index, {
      time: (clientX - rect.left - padding) / Math.max(1, rect.width - padding * 2),
      value: 1 - (clientY - rect.top - padding) / Math.max(1, rect.height - padding * 2),
    });
  };

  const addKey = () => {
    let insertIndex = 1;
    let largestGap = -1;
    for (let index = 1; index < keys.length; index += 1) {
      const gap = keys[index].time - keys[index - 1].time;
      if (gap > largestGap) { largestGap = gap; insertIndex = index; }
    }
    const time = (keys[insertIndex - 1].time + keys[insertIndex].time) * 0.5;
    const updated = structuredClone(keys);
    updated.splice(insertIndex, 0, { time, value: evaluateProgressCurve(keys, time), tangentMode: "smooth" });
    onChange(updated);
  };

  return <div className="progress-curve-editor">
    <div className="effect-list-heading"><strong>路径进度曲线</strong><button type="button" title="添加曲线关键点" onClick={addKey}><Plus size={14} /></button></div>
    <svg className="progress-curve-graph" viewBox={`0 0 ${width} ${height}`} onPointerMove={(event) => { if (dragIndex !== null) updateFromPointer(event.clientX, event.clientY, event.currentTarget, dragIndex); }} onPointerUp={() => setDragIndex(null)} onPointerCancel={() => setDragIndex(null)}>
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="curve-axis" />
      <line x1={padding} y1={padding} x2={padding} y2={height - padding} className="curve-axis" />
      <polyline points={samples.map((point) => `${point.x},${point.y}`).join(" ")} className="curve-line" />
      {keys.map((key, index) => { const point = toScreen(key); return <circle key={index} cx={point.x} cy={point.y} r={5} className="curve-key" onPointerDown={(event) => { const svg = event.currentTarget.ownerSVGElement; if (!svg) return; svg.setPointerCapture(event.pointerId); setDragIndex(index); updateFromPointer(event.clientX, event.clientY, svg, index); }} />; })}
    </svg>
    <div className="curve-presets segmented"><button type="button" onClick={() => onChange(structuredClone(CURVE_PRESETS.linear))}>匀速</button><button type="button" onClick={() => onChange(structuredClone(CURVE_PRESETS.easeIn))}>加速</button><button type="button" onClick={() => onChange(structuredClone(CURVE_PRESETS.easeOut))}>减速</button><button type="button" onClick={() => onChange(structuredClone(CURVE_PRESETS.easeInOut))}>缓入缓出</button><button type="button" onClick={() => onChange(structuredClone(CURVE_PRESETS.return))}>往返</button></div>
    <div className="curve-key-list">
      {keys.map((key, index) => <div className="curve-key-row" key={index}>
        <NumberField label="时间" value={key.time} min={0} max={1} step={0.01} onChange={(time) => updateKey(index, { time })} />
        <NumberField label="进度" value={key.value} min={0} max={1} step={0.01} onChange={(nextValue) => updateKey(index, { value: nextValue })} />
        <SelectField label="切线" value={key.tangentMode} onChange={(tangentMode) => updateKey(index, { tangentMode: tangentMode as ProgressKey["tangentMode"] })} options={[["smooth", "平滑"], ["linear", "线性"], ["flat", "平直"]]} />
        {keys.length > 2 && index > 0 && index < keys.length - 1 ? <RemoveButton onClick={() => onChange(keys.filter((_, cursor) => cursor !== index))} /> : <span />}
      </div>)}
    </div>
  </div>;
}

function MotionSettings({ value, onChange }: { value: any; onChange: (value: any) => void }) {
  const motion = value || defaultMotion();
  const patch = (next: any) => onChange({ ...motion, ...next });
  const enabled = Boolean(motion.enabled);
  const mode = motion.mode || "linear";
  return <details className="sub-effect">
    <summary>移动设置</summary>
    <div className="effect-block-body">
      <label className="toggle-row"><input type="checkbox" checked={enabled} onChange={(event) => patch({ enabled: event.target.checked })} /><span>随时间移动</span></label>
      {enabled && <>
        <SelectField label="运动模式" value={mode} onChange={(value) => patch({ mode: value })} options={[["linear", "直线"], ["bezier", "路径"]]} />
        {mode === "linear" ? <>
          <NumberField label="速度" value={numeric(motion.speed)} min={0} step={0.1} onChange={(value) => patch({ speed: value })} />
          <div className="field-grid two-columns">
            <NumberField label="方向 X" value={numeric(motion.directionX)} step={0.1} onChange={(value) => patch({ directionX: value })} />
            <NumberField label="方向 Y" value={numeric(motion.directionY)} step={0.1} onChange={(value) => patch({ directionY: value })} />
          </div>
        </> : <>
          <NumberField label="路径时长 Tick" value={numeric(motion.durationTicks)} min={1} integer onChange={(value) => patch({ durationTicks: value })} />
          <div className="field-grid two-columns">
            <NumberField label="控制点 A X" value={numeric(motion.controlAX)} step={0.1} onChange={(value) => patch({ controlAX: value })} />
            <NumberField label="控制点 A Y" value={numeric(motion.controlAY)} step={0.1} onChange={(value) => patch({ controlAY: value })} />
          </div>
          <div className="field-grid two-columns">
            <NumberField label="控制点 B X" value={numeric(motion.controlBX)} step={0.1} onChange={(value) => patch({ controlBX: value })} />
            <NumberField label="控制点 B Y" value={numeric(motion.controlBY)} step={0.1} onChange={(value) => patch({ controlBY: value })} />
          </div>
          <div className="field-grid two-columns">
            <NumberField label="终点 X" value={numeric(motion.endX)} step={0.1} onChange={(value) => patch({ endX: value })} />
            <NumberField label="终点 Y" value={numeric(motion.endY)} step={0.1} onChange={(value) => patch({ endY: value })} />
          </div>
          <ProgressCurveEditor value={motion.pathProgressCurve} onChange={(pathProgressCurve) => patch({ pathProgressCurve })} />
          <label className="toggle-row" title="进度曲线进入下降段后，从已经到达的最远点直线回收到施法者当前位置对应的生成锚点。命中检测体使用中心或射线起点，世界特效使用特效局部偏移"><input type="checkbox" checked={Boolean(motion.retargetOnDescendingPath)} onChange={(event) => patch({ retargetOnDescendingPath: event.target.checked })} /><span>下降段回收至施法者当前位置锚点</span></label>
          <button type="button" className="secondary-command" onClick={() => patch({ controlAX: numeric(motion.endX) / 3, controlAY: numeric(motion.endY) / 3, controlBX: numeric(motion.endX) * 2 / 3, controlBY: numeric(motion.endY) * 2 / 3, pathProgressCurve: structuredClone(CURVE_PRESETS.linear) })}>一键均匀拉直</button>
        </>}
      </>}
    </div>
  </details>;
}

function VfxEffects({ values, onChange, assets, onCreateAssets, timing, defaultPixelsPerUnit, title = "特效效果" }: {
  values: any[];
  onChange: (values: any[]) => void;
  assets: Record<string, AssetRef>;
  onCreateAssets: Props["onCreateAssets"];
  timing: "event" | "onHit";
  defaultPixelsPerUnit: number;
  title?: string;
}) {
  const patch = (index: number, next: any) => onChange(values.map((item, cursor) => cursor === index ? { ...item, ...next } : item));
  return <div className="nested-effect-list">
    <EffectHeader title={title} onAdd={() => onChange([...values, defaultVfx(defaultPixelsPerUnit)])} />
    {values.map((effect, index) => {
      const anchor = effect.anchor || "caster";
      const renderLayer = effect.renderLayer === "back" ? "back" : "front";
      const useFollowDuration = anchor !== "world" && Boolean(effect.useFollowDuration);
      const loop = timing === "event" && Boolean(effect.loop);
      const destroyMode = effect.destroyMode === "onActionEnd" ? "onActionEnd" : "timed";
      const anchorOptions: Array<[string, string]> = [["caster", "施法者"], ["target", "目标"], ["world", "世界"]];
      return <details className="effect-block" key={index} open={index === 0}>
        <summary><span>{index + 1}. {vfxResourceLabel(effect, assets)}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
        <div className="effect-block-body">
          <VfxResourceEditor effect={effect} assets={assets} onChange={(next) => patch(index, next)} onCreateAssets={onCreateAssets} defaultPixelsPerUnit={defaultPixelsPerUnit} />
          <div className="field-grid two-columns">
            <SelectField label="挂点" title={timing === "onHit" ? "施法者=随攻击者；目标=随本次命中的对象；世界=固定在命中时的世界坐标" : "施法者=随当前角色；目标=随当前锁定目标，敌人通常为玩家；世界=固定在触发时的世界坐标"} value={anchor} onChange={(value) => patch(index, {
              anchor: value,
              ...(value === "world" ? { useFollowDuration: false, followDurationTicks: 0 } : { motion: defaultMotion() }),
            })} options={anchorOptions} />
            <SelectField label="渲染层级" title="相对所属玩家或敌人的渲染层级，使用独立排序分区" value={renderLayer} onChange={(value) => patch(index, { renderLayer: value })} options={[["front", "人物前"], ["back", "人物后"]]} />
          </div>
          <NumberField label="生效延迟 Tick" value={numeric(effect.triggerDelayTicks)} min={0} integer onChange={(value) => patch(index, { triggerDelayTicks: value })} />
          <div className="field-grid two-columns">
            <NumberField label="位置 X" value={numeric(effect.x)} step={0.1} onChange={(value) => patch(index, { x: value })} />
            <NumberField label="位置 Y" value={numeric(effect.y)} step={0.1} onChange={(value) => patch(index, { y: value })} />
          </div>
          <div className="field-grid two-columns">
            <NumberField label="Pivot X" title="0=左侧，0.5=水平中心，1=右侧" value={numeric(effect.pivotX, 0.5)} min={0} max={1} step={0.05} onChange={(value) => patch(index, { pivotX: Math.min(1, Math.max(0, value)) })} />
            <NumberField label="Pivot Y" title="0=底部，0.5=垂直中心，1=顶部" value={numeric(effect.pivotY, 0.5)} min={0} max={1} step={0.05} onChange={(value) => patch(index, { pivotY: Math.min(1, Math.max(0, value)) })} />
          </div>
          <div className="field-grid two-columns">
            <NumberField label="旋转" value={numeric(effect.rotation)} step={0.1} onChange={(value) => patch(index, { rotation: value })} />
            <NumberField label="缩放" value={numeric(effect.scale, 1)} min={0.01} step={0.05} onChange={(value) => patch(index, { scale: value })} />
          </div>
          {anchor !== "world" && <label className="toggle-row" title="启用后只在指定时长内跟随挂点；设为 0 Tick 时只读取生成瞬间的位置"><input type="checkbox" checked={useFollowDuration} onChange={(event) => patch(index, { useFollowDuration: event.target.checked })} /><span>限制跟随时长</span></label>}
          {useFollowDuration && <NumberField label="跟随时长 Tick" title="0 Tick 表示在生成时锁定一次挂点位置，之后留在该世界坐标" value={numeric(effect.followDurationTicks)} min={0} integer onChange={(value) => patch(index, { followDurationTicks: value })} />}
          {anchor === "target" && useFollowDuration && numeric(effect.followDurationTicks) === 0 && <div className="time-readout">生成时记录目标位置，之后固定在该世界坐标</div>}
          {timing === "event" && <label className="toggle-row"><input type="checkbox" checked={loop} onChange={(event) => patch(index, event.target.checked ? { loop: true, destroyMode: "timed", durationTicks: Math.max(1, numeric(effect.durationTicks, 180)) } : { loop: false, destroyMode: "natural", durationTicks: 0 })} /><span>循环播放</span></label>}
          {loop && <SelectField label="销毁方式" value={destroyMode} onChange={(value) => patch(index, { destroyMode: value })} options={[["timed", "指定时长"], ["onActionEnd", "动作结束"]]} />}
          {loop && destroyMode === "timed" && <NumberField label="销毁 Tick" value={numeric(effect.durationTicks, 180)} min={1} integer onChange={(value) => patch(index, { durationTicks: Math.max(1, value) })} />}
          {!loop && <div className="time-readout">序列帧完整播放一次后自动结束</div>}
          {anchor === "world" && <MotionSettings value={effect.motion} onChange={(motion) => patch(index, { motion })} />}
        </div>
      </details>;
    })}
  </div>;
}

function CompanionVfxEffects({ values, onChange, assets, onCreateAssets, defaultPixelsPerUnit }: {
  values: any[];
  onChange: (values: any[]) => void;
  assets: Record<string, AssetRef>;
  onCreateAssets: Props["onCreateAssets"];
  defaultPixelsPerUnit: number;
}) {
  const patch = (index: number, next: any) => onChange(values.map((item, cursor) => cursor === index ? {
    ...item,
    ...next,
    anchor: "world",
    useFollowDuration: false,
    followDurationTicks: 0,
    triggerDelayTicks: 0,
    loop: true,
    motion: defaultMotion(),
    destroyMode: "detectionEnd",
    durationTicks: 0,
  } : item));
  const add = () => onChange([...values, {
    ...defaultVfx(defaultPixelsPerUnit),
    anchor: "world",
    loop: true,
    destroyMode: "detectionEnd",
    motion: defaultMotion(),
  }]);
  return <div className="nested-effect-list">
    <EffectHeader title="伴随特效" onAdd={add} />
    {values.map((effect, index) => <details className="effect-block" key={index} open={index === 0}>
      <summary><span>{index + 1}. {vfxResourceLabel(effect, assets)}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
      <div className="effect-block-body">
        <VfxResourceEditor effect={effect} assets={assets} onChange={(next) => patch(index, next)} onCreateAssets={onCreateAssets} defaultPixelsPerUnit={defaultPixelsPerUnit} />
        <SelectField label="渲染层级" title="相对所属玩家或敌人的渲染层级，使用独立排序分区" value={effect.renderLayer === "back" ? "back" : "front"} onChange={(value) => patch(index, { renderLayer: value })} options={[["front", "人物前"], ["back", "人物后"]]} />
        <div className="field-grid two-columns">
          <NumberField label="位置 X" value={numeric(effect.x)} step={0.1} onChange={(value) => patch(index, { x: value })} />
          <NumberField label="位置 Y" value={numeric(effect.y)} step={0.1} onChange={(value) => patch(index, { y: value })} />
          <NumberField label="Pivot X" title="0=左侧，0.5=水平中心，1=右侧" value={numeric(effect.pivotX, 0.5)} min={0} max={1} step={0.05} onChange={(value) => patch(index, { pivotX: Math.min(1, Math.max(0, value)) })} />
          <NumberField label="Pivot Y" title="0=底部，0.5=垂直中心，1=顶部" value={numeric(effect.pivotY, 0.5)} min={0} max={1} step={0.05} onChange={(value) => patch(index, { pivotY: Math.min(1, Math.max(0, value)) })} />
          <NumberField label="旋转" value={numeric(effect.rotation)} step={0.1} onChange={(value) => patch(index, { rotation: value })} />
          <NumberField label="缩放" value={numeric(effect.scale, 1)} min={0.01} step={0.05} onChange={(value) => patch(index, { scale: value })} />
        </div>
        <div className="time-readout">固定循环播放，随命中检测体运动，在检测结束时销毁</div>
      </div>
    </details>)}
  </div>;
}

function SfxEffects({ values, onChange, assets, onCreateAssets, timing, title = "音效效果" }: {
  values: any[];
  onChange: (values: any[]) => void;
  assets: Record<string, AssetRef>;
  onCreateAssets: Props["onCreateAssets"];
  timing: "event" | "onHit";
  title?: string;
}) {
  const patch = (index: number, next: any) => onChange(values.map((item, cursor) => cursor === index ? { ...item, ...next } : item));
  return <div className="nested-effect-list">
    <EffectHeader title={title} onAdd={() => onChange([...values, defaultSfx()])} />
    {values.map((effect, index) => {
      const loop = timing === "event" && Boolean(effect.loop);
      const destroyMode = effect.destroyMode === "onActionEnd" ? "onActionEnd" : "timed";
      const anchorOptions: Array<[string, string]> = timing === "onHit"
        ? [["caster", "施法者"], ["target", "目标"], ["world", "世界"]]
        : [["caster", "施法者"], ["world", "世界"]];
      return <details className="effect-block" key={index} open={index === 0}>
        <summary><span>{index + 1}. {assets[effect.assetId]?.name || "未绑定音效"}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
        <div className="effect-block-body">
          <label className="asset-bind-button"><input type="file" accept="audio/*" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) { const ids = await onCreateAssets([file], "audio"); patch(index, { assetId: ids[0] || "" }); } input.value = ""; }} /><Upload size={14} />{assets[effect.assetId]?.name || "绑定音效资源"}</label>
          <div className="field-grid two-columns">
            <SelectField label="挂点" title={timing === "onHit" ? "施法者=随攻击者；目标=随本次命中的对象；世界=固定在命中时的世界坐标" : "施法者=随当前角色；世界=固定在触发时的世界坐标"} value={effect.anchor || "caster"} onChange={(value) => patch(index, { anchor: value })} options={anchorOptions} />
            <NumberField label="生效延迟 Tick" value={numeric(effect.triggerDelayTicks)} min={0} integer onChange={(value) => patch(index, { triggerDelayTicks: value })} />
          </div>
          <div className="field-grid two-columns">
            <NumberField label="位置 X" value={numeric(effect.x)} step={0.1} onChange={(value) => patch(index, { x: value })} />
            <NumberField label="位置 Y" value={numeric(effect.y)} step={0.1} onChange={(value) => patch(index, { y: value })} />
          </div>
          {timing === "event" && <label className="toggle-row"><input type="checkbox" checked={loop} onChange={(event) => patch(index, event.target.checked ? { loop: true, destroyMode: "timed", durationTicks: Math.max(1, numeric(effect.durationTicks, 180)) } : { loop: false, destroyMode: "natural", durationTicks: 0 })} /><span>循环播放</span></label>}
          {loop && <SelectField label="销毁方式" value={destroyMode} onChange={(value) => patch(index, { destroyMode: value })} options={[["timed", "指定时长"], ["onActionEnd", "动作结束"]]} />}
          {loop && destroyMode === "timed" && <NumberField label="销毁 Tick" value={numeric(effect.durationTicks, 180)} min={1} integer onChange={(value) => patch(index, { durationTicks: Math.max(1, value) })} />}
          {!loop && <div className="time-readout">音频完整播放一次后自动结束</div>}
        </div>
      </details>;
    })}
  </div>;
}

function DamageEffects({ values, onChange, assets, onCreateAssets, defaultPixelsPerUnit, tickRate, propertyCatalog, propertyCatalogMessage }: {
  values: any[];
  onChange: (values: any[]) => void;
  assets: Record<string, AssetRef>;
  onCreateAssets: Props["onCreateAssets"];
  defaultPixelsPerUnit: number;
  tickRate: number;
  propertyCatalog: UnityPropertyCatalogEntry[];
  propertyCatalogMessage: string;
}) {
  const add = () => onChange([...values, {
    triggerDelayTicks: 0,
    detectionDurationTicks: 0,
    activationTick: 0,
    activationMode: "continuous",
    intermittentActiveTicks: 60,
    intermittentIntervalTicks: 60,
    deduplicationScope: "wholeEvent",
    detectionType: "rangeOverlap",
    hitLayerName: "Enemy",
    anchor: "world",
    useFollowDuration: false,
    followDurationTicks: 0,
    shape: "box",
    centerX: 0.8,
    centerY: 0.9,
    rotation: 0,
    radius: 1.5,
    sectorAngle: 180,
    boxWidth: 1.2,
    boxHeight: 0.7,
    boxGrowthEnabled: false,
    boxGrowthDirection: "right",
    boxGrowthSpeed: 4,
    boxGrowthDurationTicks: Math.max(1, tickRate * 2),
    rayOriginX: 0,
    rayOriginY: 0,
    rayMaxDistance: 10,
    rayRadius: 0,
    physicalLayerName: "Ground",
    physicalMass: 10,
    physicalGravityScale: 1,
    physicalLinearDamping: 0,
    physicalAngularDamping: 0.05,
    physicalFriction: 0.6,
    physicalBounciness: 0,
    physicalAllowRotation: true,
    physicalContinuousCollision: true,
    physicalInitialAngularVelocity: 0,
    physicalInheritCasterVelocity: false,
    physicalIgnoreCasterTicks: 30,
    motion: defaultMotion(),
    companionVfxEffects: [],
    onHitDamageEffects: [{ delayTicks: 0, damageMultiplier: 1, fixedDamage: 0 }],
    onHitAttributeEffects: [],
    hitStop: { durationTicks: 0, timeScale: 0, pauseCamera: false },
    onHitPhysicsEffects: [],
    onHitVfxEffects: [],
    onHitSfxEffects: [],
  }]);

  return <div className="nested-effect-list">
    <EffectHeader title="命中效果" onAdd={add} />
    {values.map((effect, index) => {
      const patch = (next: any) => onChange(values.map((item, cursor) => cursor === index ? { ...item, ...next } : item));
      const detectionType = effect.detectionType || "rangeOverlap";
      const anchor = effect.anchor || "world";
      const supportsFollowDuration = detectionType !== "physicalEntity" && anchor !== "world";
      const useFollowDuration = supportsFollowDuration && Boolean(effect.useFollowDuration);
      const shape = effect.shape || "box";
      const boxGrowthEnabled = detectionType === "rangeOverlap" && shape === "box" && Boolean(effect.boxGrowthEnabled);
      const boxGrowthDirection = ["up", "down", "left", "right"].includes(effect.boxGrowthDirection) ? effect.boxGrowthDirection : "right";
      const boxGrowthSpeed = Math.max(0, numeric(effect.boxGrowthSpeed, 4));
      const boxGrowthDurationTicks = Math.max(1, numeric(effect.boxGrowthDurationTicks, tickRate * 2));
      const visibleGrowthTicks = Math.min(boxGrowthDurationTicks, Math.max(0, numeric(effect.detectionDurationTicks)));
      const maximumExtension = boxGrowthSpeed * visibleGrowthTicks / Math.max(1, tickRate);
      const initialLength = boxGrowthDirection === "left" || boxGrowthDirection === "right" ? numeric(effect.boxWidth, 1) : numeric(effect.boxHeight, 1);
      const hitStopDuration = numeric(effect.hitStop?.durationTicks);
      const summary = detectionType === "rangeOverlap"
        ? `${index + 1}. 范围检测 / ${shape === "box" ? "盒体" : shape === "sector" ? "扇形" : "圆形"}`
        : detectionType === "physicalEntity"
          ? `${index + 1}. 物理实体 / ${shape === "circle" ? "圆形" : "盒体"}`
          : `${index + 1}. 射线检测`;
      return <details className="effect-block" key={index} open={index === 0}>
        <summary><span>{summary}</span><RemoveButton onClick={() => onChange(values.filter((_, cursor) => cursor !== index))} /></summary>
        <div className="effect-block-body">
          <div className="field-grid two-columns">
            <SelectField label="检测方式" value={detectionType} onChange={(value) => patch(value === "physicalEntity"
              ? { detectionType: value, shape: shape === "circle" ? "circle" : "box", anchor: effect.anchor || "world", motion: (effect.anchor || "world") !== "world" ? defaultMotion() : effect.motion || defaultMotion(), detectionDurationTicks: numeric(effect.detectionDurationTicks) > 0 ? numeric(effect.detectionDurationTicks) : 600, boxGrowthEnabled: false }
              : { detectionType: value, ...(value === "rangeOverlap" ? {} : { boxGrowthEnabled: false }) })} options={[["rangeOverlap", "范围检测"], ["raycast", "射线检测"], ["physicalEntity", "物理实体"]]} />
            <label className="field"><span>命中层级名</span><DeferredTextInput value={effect.hitLayerName || ""} onValueChange={(value) => patch({ hitLayerName: value })} /></label>
            <NumberField label="生效延迟 Tick" title="事件触发时记录挂点位置、旋转、朝向和检测配置；延迟结束后以这份快照开始生成或检测" value={numeric(effect.triggerDelayTicks)} min={0} integer onChange={(value) => patch({ triggerDelayTicks: Math.max(0, Math.round(value)) })} />
            <NumberField label={detectionType === "physicalEntity" ? "持续时长 Tick" : "检测时长 Tick"} title={detectionType === "physicalEntity" ? "物理实体和伴随特效从生效生成到回收的持续时间" : "从命中检测生效时刻起算的完整检测窗口。为 0 时在生效时立即检测一次"} value={numeric(effect.detectionDurationTicks)} min={detectionType === "physicalEntity" ? 1 : 0} integer onChange={(value) => {
              const detectionDurationTicks = Math.max(detectionType === "physicalEntity" ? 1 : 0, value);
              patch({ detectionDurationTicks, activationTick: Math.min(Math.max(0, numeric(effect.activationTick)), detectionDurationTicks) });
            }} />
            <NumberField label="激活时刻 Tick" title={`从${detectionType === "physicalEntity" ? "实体生成" : "检测窗口起点"}开始计算，经过多少 Tick 后启用伤害检测。取值范围为 0 到${detectionType === "physicalEntity" ? "持续时长" : "检测时长"}`} value={numeric(effect.activationTick)} min={0} max={Math.max(0, numeric(effect.detectionDurationTicks))} integer onChange={(value) => patch({ activationTick: Math.min(Math.max(0, value), Math.max(0, numeric(effect.detectionDurationTicks))) })} />
            <SelectField label="激活方式" value={effect.activationMode || "continuous"} onChange={(value) => patch({ activationMode: value })} options={[["continuous", "持续激活"], ["intermittent", "间断激活"]]} />
            <SelectField label="命中去重" title="整个事件=每个目标只命中一次；每次激活=每个激活轮次可重新命中一次；每次检测=每次物理检测都可重新命中" value={effect.deduplicationScope || "wholeEvent"} onChange={(value) => patch({ deduplicationScope: value })} options={[["wholeEvent", "整个事件"], ["perActivation", "每次激活"], ["perDetection", "每次检测"]]} />
          </div>

          {effect.activationMode === "intermittent" && <div className="field-grid two-columns">
            <NumberField label="激活时长 Tick" value={numeric(effect.intermittentActiveTicks)} min={1} integer onChange={(value) => patch({ intermittentActiveTicks: value })} />
            <NumberField label="间隔时长 Tick" title="允许设为 0；此时各激活轮次首尾相接，但仍会按激活时长划分为独立轮次" value={numeric(effect.intermittentIntervalTicks)} min={0} integer onChange={(value) => patch({ intermittentIntervalTicks: value })} />
          </div>}

          {(detectionType === "rangeOverlap" || detectionType === "physicalEntity") && <>
            <div className="field-grid two-columns">
              <SelectField label="锚点" title={detectionType === "physicalEntity" ? "自身=在施法者位置生成；目标=在当前锁定目标位置生成；世界=在事件触发时记录施法者位置。物理实体生成后均由 Rigidbody2D 独立运动" : "自身=检测期间跟随施法者；目标=检测期间跟随当前锁定目标；世界=固定在事件触发时记录的施法者位置"} value={anchor} onChange={(value) => patch(value === "world" ? { anchor: value, useFollowDuration: false, followDurationTicks: 0 } : { anchor: value, motion: defaultMotion() })} options={[["self", "自身"], ["target", "目标"], ["world", "世界"]]} />
              <SelectField label={detectionType === "physicalEntity" ? "实体形状" : "范围形状"} value={shape} onChange={(value) => patch({ shape: value, ...(value === "box" && detectionType === "rangeOverlap" ? {} : { boxGrowthEnabled: false }) })} options={detectionType === "physicalEntity" ? [["circle", "圆形"], ["box", "盒体"]] : [["circle", "圆形"], ["sector", "扇形"], ["box", "盒体"]]} />
              <NumberField label="中心 X" value={numeric(effect.centerX)} step={0.1} onChange={(value) => patch({ centerX: value })} />
              <NumberField label="中心 Y" value={numeric(effect.centerY)} step={0.1} onChange={(value) => patch({ centerY: value })} />
              {(detectionType === "physicalEntity" || shape === "sector" || shape === "box") && <NumberField label="旋转" value={numeric(effect.rotation)} step={0.1} onChange={(value) => patch({ rotation: value })} />}
              {(shape === "circle" || shape === "sector") && <NumberField label="半径" value={numeric(effect.radius)} min={0.01} step={0.1} onChange={(value) => patch({ radius: value })} />}
              {shape === "sector" && <NumberField label="扇形角度" value={numeric(effect.sectorAngle)} min={1} max={360} onChange={(value) => patch({ sectorAngle: value })} />}
              {shape === "box" && <NumberField label="盒体宽度" value={numeric(effect.boxWidth)} min={0.01} step={0.1} onChange={(value) => patch({ boxWidth: value })} />}
              {shape === "box" && <NumberField label="盒体高度" value={numeric(effect.boxHeight)} min={0.01} step={0.1} onChange={(value) => patch({ boxHeight: value })} />}
            </div>
            {detectionType === "rangeOverlap" && shape === "box" && <>
              <label className="toggle-row" title="保持盒体反方向一侧不动，从命中检测生效时刻开始沿指定方向伸长"><input type="checkbox" checked={boxGrowthEnabled} onChange={(event) => patch({ boxGrowthEnabled: event.target.checked })} /><span>随时间伸长</span></label>
              {boxGrowthEnabled && <>
                <div className="field-grid two-columns">
                  <SelectField label="伸长方向" title="左右方向使用动作局部坐标并随角色转向镜像；四个方向都会跟随盒体旋转" value={boxGrowthDirection} onChange={(value) => patch({ boxGrowthDirection: value })} options={[["right", "右"], ["left", "左"], ["up", "上"], ["down", "下"]]} />
                  <NumberField label="伸长速度（米/秒）" value={boxGrowthSpeed} min={0.01} step={0.1} onChange={(value) => patch({ boxGrowthSpeed: Math.max(0.01, value) })} />
                  <NumberField label="伸长时长 Tick" title={`当前项目 ${tickRate} Tick = 1 秒`} value={boxGrowthDurationTicks} min={1} integer onChange={(value) => patch({ boxGrowthDurationTicks: Math.max(1, value) })} />
                </div>
                <div className="time-readout">初始长度 {initialLength.toFixed(2)} 米 · {(visibleGrowthTicks / Math.max(1, tickRate)).toFixed(3)} 秒内伸长 {maximumExtension.toFixed(2)} 米 · 最终长度 {(initialLength + maximumExtension).toFixed(2)} 米</div>
              </>}
            </>}
          </>}

          {detectionType === "raycast" && <div className="field-grid two-columns">
            <SelectField label="锚点" value={anchor} onChange={(value) => patch(value === "self" ? { anchor: value, motion: defaultMotion() } : { anchor: value, useFollowDuration: false, followDurationTicks: 0 })} options={[["world", "世界"], ["self", "自身"]]} />
            <NumberField label="旋转" value={numeric(effect.rotation)} step={0.1} onChange={(value) => patch({ rotation: value })} />
            <NumberField label="射线起点 X" value={numeric(effect.rayOriginX)} step={0.1} onChange={(value) => patch({ rayOriginX: value })} />
            <NumberField label="射线起点 Y" value={numeric(effect.rayOriginY)} step={0.1} onChange={(value) => patch({ rayOriginY: value })} />
            <NumberField label="射线距离" value={numeric(effect.rayMaxDistance)} min={0.01} step={0.1} onChange={(value) => patch({ rayMaxDistance: value })} />
            <NumberField label="射线半径" value={numeric(effect.rayRadius)} min={0} step={0.1} onChange={(value) => patch({ rayRadius: value })} />
          </div>}

          {supportsFollowDuration && <label className="toggle-row" title="启用后只在指定时长内跟随锚点；设为 0 Tick 时只读取事件触发瞬间的位置"><input type="checkbox" checked={useFollowDuration} onChange={(event) => patch({ useFollowDuration: event.target.checked })} /><span>限制跟随时长</span></label>}
          {useFollowDuration && <NumberField label="跟随时长 Tick" title="0 Tick 表示在事件触发时锁定一次锚点位置，之后固定在该世界坐标" value={numeric(effect.followDurationTicks)} min={0} integer onChange={(value) => patch({ followDurationTicks: Math.max(0, Math.round(value)) })} />}
          {anchor === "target" && useFollowDuration && numeric(effect.followDurationTicks) === 0 && <div className="time-readout">触发时记录目标位置，之后固定在该世界坐标</div>}

          {detectionType === "physicalEntity" && <>
            <div className="field-grid two-columns">
              <label className="field"><span>实体 Layer</span><DeferredTextInput value={effect.physicalLayerName || ""} onValueChange={(value) => patch({ physicalLayerName: value })} /></label>
              <NumberField label="质量" value={numeric(effect.physicalMass, 10)} min={0.01} step={0.1} onChange={(value) => patch({ physicalMass: value })} />
              <NumberField label="重力倍率" value={numeric(effect.physicalGravityScale, 1)} min={0} step={0.1} onChange={(value) => patch({ physicalGravityScale: value })} />
              <NumberField label="线性阻尼" value={numeric(effect.physicalLinearDamping)} min={0} step={0.05} onChange={(value) => patch({ physicalLinearDamping: value })} />
              <NumberField label="旋转阻尼" value={numeric(effect.physicalAngularDamping, 0.05)} min={0} step={0.05} onChange={(value) => patch({ physicalAngularDamping: value })} />
              <NumberField label="摩擦力" value={numeric(effect.physicalFriction, 0.6)} min={0} max={1} step={0.05} onChange={(value) => patch({ physicalFriction: value })} />
              <NumberField label="弹性" value={numeric(effect.physicalBounciness)} min={0} max={1} step={0.05} onChange={(value) => patch({ physicalBounciness: value })} />
              <NumberField label="初始角速度" value={numeric(effect.physicalInitialAngularVelocity)} step={1} onChange={(value) => patch({ physicalInitialAngularVelocity: value })} />
              <NumberField label="忽略施法者碰撞 Tick" value={numeric(effect.physicalIgnoreCasterTicks, 30)} min={0} integer onChange={(value) => patch({ physicalIgnoreCasterTicks: value })} />
            </div>
            <label className="toggle-row"><input type="checkbox" checked={effect.physicalAllowRotation !== false} onChange={(event) => patch({ physicalAllowRotation: event.target.checked })} /><span>允许旋转</span></label>
            <label className="toggle-row"><input type="checkbox" checked={effect.physicalContinuousCollision !== false} onChange={(event) => patch({ physicalContinuousCollision: event.target.checked })} /><span>连续碰撞检测</span></label>
            <label className="toggle-row"><input type="checkbox" checked={Boolean(effect.physicalInheritCasterVelocity)} onChange={(event) => patch({ physicalInheritCasterVelocity: event.target.checked })} /><span>继承施法者速度</span></label>
          </>}

          {(effect.anchor || "world") === "world" && <MotionSettings value={effect.motion} onChange={(motion) => patch({ motion })} />}

          <div className="nested-effect-list">
            <EffectHeader title="命中伤害效果" onAdd={() => patch({ onHitDamageEffects: [...(effect.onHitDamageEffects || []), { delayTicks: 0, damageMultiplier: 1, fixedDamage: 0 }] })} />
            {(effect.onHitDamageEffects || []).map((item: any, hitIndex: number) => <div className="inline-effect-row" key={hitIndex}>
              <NumberField label="延迟 Tick" value={numeric(item.delayTicks)} min={0} integer onChange={(value) => { const list = structuredClone(effect.onHitDamageEffects); list[hitIndex].delayTicks = value; patch({ onHitDamageEffects: list }); }} />
              <NumberField label="伤害倍率" title="原样传递给 Unity 的倍率字段，可输入负值；具体计算由命中接收方实现" value={numeric(item.damageMultiplier)} step={0.1} onChange={(value) => { const list = structuredClone(effect.onHitDamageEffects); list[hitIndex].damageMultiplier = value; patch({ onHitDamageEffects: list }); }} />
              <NumberField label="固定伤害值" title="原样传递给 Unity 的固定值字段，可输入负值；具体计算由命中接收方实现" value={numeric(item.fixedDamage)} step={1} onChange={(value) => { const list = structuredClone(effect.onHitDamageEffects); list[hitIndex].fixedDamage = value; patch({ onHitDamageEffects: list }); }} />
              <RemoveButton onClick={() => patch({ onHitDamageEffects: effect.onHitDamageEffects.filter((_: any, cursor: number) => cursor !== hitIndex) })} />
            </div>)}
          </div>

          <AttributeEffects
            title="命中属性事件"
            values={effect.onHitAttributeEffects || []}
            onChange={(next) => patch({ onHitAttributeEffects: next })}
            propertyCatalog={propertyCatalog}
            propertyCatalogMessage={propertyCatalogMessage}
            nested
          />

          <details className="sub-effect" open>
            <summary>命中停顿</summary>
            <div className="effect-block-body">
              <NumberField label="停顿 Tick" value={hitStopDuration} min={0} integer onChange={(value) => patch({ hitStop: { ...effect.hitStop, durationTicks: value } })} />
              {hitStopDuration > 0 && <>
                <NumberField label="时间缩放" value={numeric(effect.hitStop?.timeScale)} min={0} max={1} step={0.05} onChange={(value) => patch({ hitStop: { ...effect.hitStop, timeScale: value } })} />
                <label className="toggle-row"><input type="checkbox" checked={Boolean(effect.hitStop?.pauseCamera)} onChange={(event) => patch({ hitStop: { ...effect.hitStop, pauseCamera: event.target.checked } })} /><span>同时暂停镜头输入</span></label>
              </>}
            </div>
          </details>

          <PhysicsEffects title="命中物理效果" values={effect.onHitPhysicsEffects || []} onChange={(next) => patch({ onHitPhysicsEffects: next })} scope="onHit" />
          <CompanionVfxEffects values={effect.companionVfxEffects || []} onChange={(next) => patch({ companionVfxEffects: next })} assets={assets} onCreateAssets={onCreateAssets} defaultPixelsPerUnit={defaultPixelsPerUnit} />
          <VfxEffects title="命中特效" values={effect.onHitVfxEffects || []} onChange={(next) => patch({ onHitVfxEffects: next })} assets={assets} onCreateAssets={onCreateAssets} timing="onHit" defaultPixelsPerUnit={defaultPixelsPerUnit} />
          <SfxEffects title="命中音效" values={effect.onHitSfxEffects || []} onChange={(next) => patch({ onHitSfxEffects: next })} assets={assets} onCreateAssets={onCreateAssets} timing="onHit" />
        </div>
      </details>;
    })}
  </div>;
}

export default function SkillEventInspector({ event, track, tickRate, defaultPixelsPerUnit, assets, propertyCatalog, propertyCatalogMessage, onUpdate, onCreateAssets, onDelete }: Props) {
  const updateParams = (mutator: (draft: Record<string, any>) => void) => {
    const next = structuredClone(event.params || {});
    mutator(next);
    onUpdate({ params: next });
  };
  const params = event.params || {};
  const repeated = event.triggerMode === "repeated";
  const timedTrack = ["damage", "physics", "vfx", "sfx", "attribute"].includes(track.kind);
  const intervalTrack = track.kind === "speed" || track.kind === "camera";
  const intervalDurationMode = params.durationMode || "fixed";

  return <section className="inspector-section event-inspector">
    <div className="section-heading"><div><strong>事件属性</strong><span>{track.name}</span></div><button type="button" className="icon-button small danger" title="删除当前事件" onClick={onDelete}><Trash2 size={14} /></button></div>
    <label className="field"><span>事件标识</span><DeferredTextInput value={event.name} onValueChange={(value) => onUpdate({ name: value })} /></label>
    <NumberField label="触发 Tick" value={event.startTick} min={0} integer onChange={(value) => onUpdate({ startTick: Math.max(0, Math.round(value)) })} />
    <div className="time-readout">触发 {(event.startTick / tickRate).toFixed(3)}s · 所有事件使用动作时间锚点</div>

    {timedTrack && <>
      <SelectField label="触发模式" value={event.triggerMode} onChange={(value) => onUpdate({ triggerMode: value as TimelineEvent["triggerMode"], durationTicks: value === "once" ? 0 : Math.max(10, event.durationTicks || 60) })} options={[["once", "一次"], ["repeated", "重复"]]} />
      {repeated && <div className="field-grid two-columns">
        <SelectField label="持续方式" value={event.activeDurationMode} onChange={(value) => onUpdate({ activeDurationMode: value as TimelineEvent["activeDurationMode"] })} options={[["fixed", "指定时长"], ["untilActionEnd", "动作结束"]]} />
        <NumberField label="重复间隔 Tick" value={event.repeatIntervalTicks} min={1} integer onChange={(value) => onUpdate({ repeatIntervalTicks: Math.max(1, Math.round(value)) })} />
        {event.activeDurationMode === "fixed" && <NumberField label="持续 Tick" value={event.durationTicks} min={0} integer onChange={(value) => onUpdate({ durationTicks: Math.max(0, Math.round(value)) })} />}
      </div>}
    </>}

    {intervalTrack && <>
      <SelectField label="持续方式" value={intervalDurationMode} onChange={(value) => updateParams((draft) => { draft.durationMode = value; })} options={[["fixed", "指定时长"], ["untilActionEnd", "动作结束"]]} />
      {intervalDurationMode === "fixed" && <NumberField label="持续 Tick" value={event.durationTicks} min={0} integer onChange={(value) => onUpdate({ durationTicks: Math.max(0, Math.round(value)) })} />}
    </>}

    {track.kind === "damage" && <>
      {repeated && <SelectField label="重复锚点模式" title="只影响世界锚点。跟随=每次重复触发重新采样施法者位置；固定=所有重复触发复用第一次采样。自身锚点实时跟随施法者；目标锚点每次触发读取当前目标" value={params.repeatedAnchorMode || "follow"} onChange={(value) => updateParams((draft) => { draft.repeatedAnchorMode = value; })} options={[["follow", "跟随施法者"], ["fixed", "固定首次锚点"]]} />}
      <DamageEffects values={params.damageEffects || []} onChange={(values) => updateParams((draft) => { draft.damageEffects = values; })} assets={assets} onCreateAssets={onCreateAssets} defaultPixelsPerUnit={defaultPixelsPerUnit} tickRate={tickRate} propertyCatalog={propertyCatalog} propertyCatalogMessage={propertyCatalogMessage} />
    </>}
    {track.kind === "physics" && <PhysicsEffects values={params.physicsEffects || []} onChange={(values) => updateParams((draft) => { draft.physicsEffects = values; })} scope="topLevel" />}
    {track.kind === "vfx" && <VfxEffects values={params.vfxEffects || []} onChange={(values) => updateParams((draft) => { draft.vfxEffects = values; })} assets={assets} onCreateAssets={onCreateAssets} timing="event" defaultPixelsPerUnit={defaultPixelsPerUnit} />}
    {track.kind === "sfx" && <SfxEffects values={params.sfxEffects || []} onChange={(values) => updateParams((draft) => { draft.sfxEffects = values; })} assets={assets} onCreateAssets={onCreateAssets} timing="event" />}
    {track.kind === "attribute" && <AttributeEffects title="属性效果" values={params.attributeEffects || []} onChange={(values) => updateParams((draft) => { draft.attributeEffects = values; })} propertyCatalog={propertyCatalog} propertyCatalogMessage={propertyCatalogMessage} nested={false} />}
    {track.kind === "speed" && <div className="field-grid two-columns">
      <NumberField label="施法速度倍率" title="影响当前动作动画播放速度和动作时间轴推进速度" value={numeric(params.castSpeedMultiplier, 1)} min={0.01} step={0.05} onChange={(value) => updateParams((draft) => { draft.castSpeedMultiplier = value; })} />
      <NumberField label="运动速度倍率" title="提供给角色移动代码，影响走跑、空中移动、下落等运动速度，不改变当前动作时间轴" value={numeric(params.movementSpeedMultiplier, 1)} min={0} step={0.05} onChange={(value) => updateParams((draft) => { draft.movementSpeedMultiplier = value; })} />
    </div>}
    {track.kind === "camera" && <>
      <SelectField label="位置模式" value={params.positionMode || "hold"} onChange={(value) => updateParams((draft) => { draft.positionMode = value; })} options={[["hold", "固定"], ["bezier", "路径"]]} />
      {params.positionMode === "bezier" ? <div className="field-grid two-columns">
        <NumberField label="起点 X" value={numeric(params.pathStartX)} step={0.1} onChange={(value) => updateParams((draft) => { draft.pathStartX = value; })} />
        <NumberField label="起点 Y" value={numeric(params.pathStartY)} step={0.1} onChange={(value) => updateParams((draft) => { draft.pathStartY = value; })} />
        <NumberField label="控制点 A X" value={numeric(params.controlAX)} step={0.1} onChange={(value) => updateParams((draft) => { draft.controlAX = value; })} />
        <NumberField label="控制点 A Y" value={numeric(params.controlAY)} step={0.1} onChange={(value) => updateParams((draft) => { draft.controlAY = value; })} />
        <NumberField label="控制点 B X" value={numeric(params.controlBX)} step={0.1} onChange={(value) => updateParams((draft) => { draft.controlBX = value; })} />
        <NumberField label="控制点 B Y" value={numeric(params.controlBY)} step={0.1} onChange={(value) => updateParams((draft) => { draft.controlBY = value; })} />
        <NumberField label="终点 X" value={numeric(params.endX)} step={0.1} onChange={(value) => updateParams((draft) => { draft.endX = value; })} />
        <NumberField label="终点 Y" value={numeric(params.endY)} step={0.1} onChange={(value) => updateParams((draft) => { draft.endY = value; })} />
      </div> : <div className="field-grid two-columns">
        <NumberField label="偏移 X" value={numeric(params.offsetX)} step={0.1} onChange={(value) => updateParams((draft) => { draft.offsetX = value; })} />
        <NumberField label="偏移 Y" value={numeric(params.offsetY)} step={0.1} onChange={(value) => updateParams((draft) => { draft.offsetY = value; })} />
      </div>}
      {params.positionMode === "bezier" && <ProgressCurveEditor value={params.pathProgressCurve} onChange={(pathProgressCurve) => updateParams((draft) => { draft.pathProgressCurve = pathProgressCurve; })} />}
      <div className="field-grid two-columns">
        <NumberField label="缩放" value={numeric(params.zoom, 1)} min={0.01} step={0.05} onChange={(value) => updateParams((draft) => { draft.zoom = value; })} />
        <NumberField label="混入 Tick" value={numeric(params.blendInTicks)} min={0} integer onChange={(value) => updateParams((draft) => { draft.blendInTicks = value; })} />
        <NumberField label="混出 Tick" value={numeric(params.blendOutTicks)} min={0} integer onChange={(value) => updateParams((draft) => { draft.blendOutTicks = value; })} />
      </div>
    </>}
  </section>;
}
