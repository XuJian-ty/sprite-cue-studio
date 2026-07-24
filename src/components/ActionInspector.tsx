import type { ActionSegment, CharacterAction, CharacterProject } from "../types";
import { createEnemySkillSettings } from "../model";
import DeferredTextInput from "./DeferredTextInput";
import NumericInput from "./NumericInput";

const KEYBOARD_CODE_OPTIONS: Array<[string, string]> = [
  ["W", "W 键"], ["A", "A 键"], ["S", "S 键"], ["D", "D 键"],
  ["J", "J 键"], ["K", "K 键"], ["L", "L 键"], ["U", "U 键"], ["I", "I 键"], ["O", "O 键"],
  ["Q", "Q 键"], ["E", "E 键"], ["R", "R 键"], ["F", "F 键"], ["G", "G 键"], ["H", "H 键"],
  ["Z", "Z 键"], ["X", "X 键"], ["C", "C 键"], ["V", "V 键"], ["B", "B 键"], ["N", "N 键"], ["M", "M 键"],
  ["Space", "空格 Space"], ["LeftShift", "左 Shift"], ["LeftCtrl", "左 Ctrl"], ["Escape", "Esc"],
  ["Digit1", "数字 1"], ["Digit2", "数字 2"], ["Digit3", "数字 3"], ["Digit4", "数字 4"],
  ["Digit5", "数字 5"], ["Digit6", "数字 6"], ["Digit7", "数字 7"], ["Digit8", "数字 8"], ["Digit9", "数字 9"], ["Digit0", "数字 0"],
];

const TRIGGER_CODE_OPTIONS: Record<string, Array<[string, string]>> = {
  keyboard: KEYBOARD_CODE_OPTIONS,
  keyboardChord: KEYBOARD_CODE_OPTIONS,
  axisTap: [["A/D", "A / D"], ["LeftArrow/RightArrow", "左 / 右方向键"], ["A/D/LeftArrow/RightArrow", "A/D + 左/右方向键"]],
  axisDoubleTap: [["A/D", "A / D"], ["LeftArrow/RightArrow", "左 / 右方向键"], ["A/D/LeftArrow/RightArrow", "A/D + 左/右方向键"]],
  mouse: [["Mouse0", "鼠标左键"], ["Mouse1", "鼠标右键"], ["Mouse2", "鼠标中键"], ["Mouse3", "鼠标侧键 1"], ["Mouse4", "鼠标侧键 2"]],
  damage: [["Damage", "受到伤害"]],
  custom: [["Skill1", "自定义 Skill1"], ["Skill2", "自定义 Skill2"], ["Interact", "自定义 Interact"], ["Dodge", "自定义 Dodge"], ["Ultimate", "自定义 Ultimate"]],
};

interface ActionInspectorProps {
  scope: "character" | "action";
  project: CharacterProject;
  action: CharacterAction;
  segment: ActionSegment;
  onUpdateProject: (patch: Partial<CharacterProject>) => void;
  onUpdateAction: (patch: Partial<CharacterAction>) => void;
  onUpdateSegment: (patch: Partial<ActionSegment>) => void;
}

function NumberField({ label, title, value, min, max, step = 1, integer = false, onChange }: {
  label: string;
  title?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <NumericInput value={value} min={min} max={max} step={step} integer={integer} title={title} onValueChange={onChange} />
    </label>
  );
}

export default function ActionInspector({
  scope,
  project,
  action,
  segment,
  onUpdateProject,
  onUpdateAction,
  onUpdateSegment,
}: ActionInspectorProps) {
  const triggerOptions = [...(TRIGGER_CODE_OPTIONS[action.trigger.type] || [])];
  if (action.trigger.code && !triggerOptions.some(([value]) => value === action.trigger.code)) triggerOptions.push([action.trigger.code, action.trigger.code]);
  const secondaryTriggerOptions = [...KEYBOARD_CODE_OPTIONS];
  if (action.trigger.secondaryCode && !secondaryTriggerOptions.some(([value]) => value === action.trigger.secondaryCode)) secondaryTriggerOptions.push([action.trigger.secondaryCode, action.trigger.secondaryCode]);
  const idleAction = action.type === "idleGround" || action.type === "idleAir";
  const isEnemy = project.projectKind === "enemy";
  const motor = project.motor;
  const cameraFollow = project.cameraFollow;
  const unityCharacter = project.unityCharacter;
  const enemySkill = action.enemySkill || createEnemySkillSettings();
  const updateMotor = (patch: Partial<CharacterProject["motor"]>) => onUpdateProject({ motor: { ...motor, ...patch } });
  const updateCameraFollow = (patch: Partial<CharacterProject["cameraFollow"]>) => onUpdateProject({ cameraFollow: { ...cameraFollow, ...patch } });
  const updateUnityCharacter = (patch: Partial<CharacterProject["unityCharacter"]>) => onUpdateProject({ unityCharacter: { ...unityCharacter, ...patch } });
  return (
    <>
      <div className="inspector-scope" hidden={scope !== "character"}>
      <section className="inspector-section">
        <div className="section-heading"><div><strong>{isEnemy ? "Unity 敌人装配" : "Unity 角色装配"}</strong><span>更新指定 Prefab</span></div></div>
        <label className="field" title={`Unity 项目 Assets 目录内的${isEnemy ? "敌人" : "角色"} Prefab 路径。存在时就地更新 Frame Action 管理内容；留空或路径不存在时创建新 Prefab`}><span>目标{isEnemy ? "敌人" : "角色"} Prefab</span><DeferredTextInput value={unityCharacter.prefabPath} placeholder={isEnemy ? "Assets/Enemies/Slime.prefab；留空时创建新敌人" : "Assets/Characters/Hero.prefab；留空时创建新角色"} onValueChange={(value) => updateUnityCharacter({ prefabPath: value })} /></label>
        <div className="field-grid two-columns">
          <label className="field" title="角色与地面、墙体和其它实体发生物理接触的 Collider2D，不是攻击命中范围"><span>身体碰撞体</span><select value={unityCharacter.colliderShape} onChange={(event) => updateUnityCharacter({ colliderShape: event.target.value as CharacterProject["unityCharacter"]["colliderShape"] })}><option value="capsule">胶囊</option><option value="box">盒体</option></select></label>
          <NumberField label="刚体质量" title="写入 Rigidbody2D.mass，影响碰撞冲量和外力效果；标准走跑主要由速度驱动" value={unityCharacter.rigidbodyMass} min={0.01} step={0.1} onChange={(value) => updateUnityCharacter({ rigidbodyMass: value })} />
        </div>
        <div className="field-grid two-columns">
          <NumberField label="碰撞体宽度" title="身体碰撞体在 Unity 世界单位中的宽度" value={unityCharacter.colliderWidth} min={0.01} step={0.05} onChange={(value) => updateUnityCharacter({ colliderWidth: value })} />
          <NumberField label="碰撞体高度" title="身体碰撞体在 Unity 世界单位中的高度" value={unityCharacter.colliderHeight} min={0.01} step={0.05} onChange={(value) => updateUnityCharacter({ colliderHeight: value })} />
          <NumberField label="碰撞体偏移 X" title="碰撞体中心相对角色根节点的水平偏移，不随角色朝向镜像" value={unityCharacter.colliderOffsetX} step={0.05} onChange={(value) => updateUnityCharacter({ colliderOffsetX: value })} />
          <NumberField label="碰撞体偏移 Y" title="碰撞体中心相对角色根节点的垂直偏移；脚底为根节点时通常约等于高度的一半" value={unityCharacter.colliderOffsetY} step={0.05} onChange={(value) => updateUnityCharacter({ colliderOffsetY: value })} />
        </div>
        <label className="toggle-row" title="只控制玩家与敌人、敌人与敌人根节点身体 Collider2D 之间的接触；命中受击区域、地面、墙体和其它物体的碰撞不受影响。参与碰撞的两边都启用后才会发生身体碰撞"><input type="checkbox" checked={unityCharacter.collideWithOtherActors} onChange={(event) => updateUnityCharacter({ collideWithOtherActors: event.target.checked })} /><span>启用角色—敌人身体碰撞</span></label>
        <p className="inspector-help">关闭后玩家与敌人、敌人与敌人的身体会互相穿透，攻击命中、受击区域、地面和墙体仍照常工作。要恢复身体碰撞，参与碰撞的两边都打开此开关后重新同步。</p>
        <div className="subsection-heading"><strong>受击区域</strong></div>
        <div className="field-grid two-columns">
          <label className="field" title="角色被范围或射线攻击检测时使用的 Trigger Collider2D"><span>受击区域形状</span><select value={unityCharacter.hurtboxShape} onChange={(event) => updateUnityCharacter({ hurtboxShape: event.target.value as CharacterProject["unityCharacter"]["hurtboxShape"] })}><option value="capsule">胶囊</option><option value="box">盒体</option></select></label>
          <span />
          <NumberField label="受击区域宽度" title="独立受击区域在 Unity 世界单位中的宽度" value={unityCharacter.hurtboxWidth} min={0.01} step={0.05} onChange={(value) => updateUnityCharacter({ hurtboxWidth: value })} />
          <NumberField label="受击区域高度" title="独立受击区域在 Unity 世界单位中的高度" value={unityCharacter.hurtboxHeight} min={0.01} step={0.05} onChange={(value) => updateUnityCharacter({ hurtboxHeight: value })} />
          <NumberField label="受击区域偏移 X" title="受击区域中心相对角色根节点的水平偏移" value={unityCharacter.hurtboxOffsetX} step={0.05} onChange={(value) => updateUnityCharacter({ hurtboxOffsetX: value })} />
          <NumberField label="受击区域偏移 Y" title="受击区域中心相对角色根节点的垂直偏移" value={unityCharacter.hurtboxOffsetY} step={0.05} onChange={(value) => updateUnityCharacter({ hurtboxOffsetY: value })} />
        </div>
      </section>

      {isEnemy && <section className="inspector-section">
        <div className="section-heading"><div><strong>敌人运行</strong><span>动作、AI和物理自动装配</span></div></div>
        <label className="toggle-row" title="Prefab 启用时自动播放地面待机；关闭后由行为树决定首个动作"><input type="checkbox" checked={project.enemyBehavior?.playGroundIdleOnEnable !== false} onChange={(event) => project.enemyBehavior && onUpdateProject({ enemyBehavior: { ...project.enemyBehavior, playGroundIdleOnEnable: event.target.checked } })} /><span>启用时播放地面待机</span></label>
        <label className="toggle-row" title="技能或受击等单次动作结束后自动回到当前地面/空中待机；关闭后由行为树继续下发动作"><input type="checkbox" checked={project.enemyBehavior?.returnToIdleOnComplete === true} onChange={(event) => project.enemyBehavior && onUpdateProject({ enemyBehavior: { ...project.enemyBehavior, returnToIdleOnComplete: event.target.checked } })} /><span>单次动作结束后回待机</span></label>
        <p className="inspector-help">同步后会自动添加敌人控制器、行为树运行器、Rigidbody2D 横向移动、墙壁和悬崖检测。巡逻、追击和目标配置位于“AI”页。</p>
      </section>}

      {!isEnemy && <>
      <section className="inspector-section">
        <div className="section-heading"><div><strong>摄像机跟随</strong><span>自动限制在地图范围内</span></div></div>
        <label className="toggle-row" title="角色 Prefab 运行时自动控制 Main Camera，并以当前角色为跟随目标"><input type="checkbox" checked={cameraFollow.enabled} onChange={(event) => updateCameraFollow({ enabled: event.target.checked })} /><span>启用摄像机跟随</span></label>
        {cameraFollow.enabled && <>
          <div className="field-grid two-columns">
            <label className="toggle-row" title="摄像机中心跟随角色的世界 X 坐标"><input type="checkbox" checked={cameraFollow.followHorizontal} onChange={(event) => updateCameraFollow({ followHorizontal: event.target.checked })} /><span>横向跟随</span></label>
            <label className="toggle-row" title="摄像机中心跟随角色的世界 Y 坐标"><input type="checkbox" checked={cameraFollow.followVertical} onChange={(event) => updateCameraFollow({ followVertical: event.target.checked })} /><span>纵向跟随</span></label>
            <NumberField label="平滑时间(秒)" title="摄像机追上角色目标位置的大致缓动时间；0 表示立即跟随" value={cameraFollow.smoothTime} min={0} step={0.01} onChange={(value) => updateCameraFollow({ smoothTime: value })} />
            <NumberField label="正交尺寸" title="Unity 正交摄像机的半屏高度；数值越大，画面可见范围越大" value={cameraFollow.orthographicSize} min={0.01} step={0.1} onChange={(value) => updateCameraFollow({ orthographicSize: value })} />
            <NumberField label="画面偏移 X" title="跟随中心相对角色位置的水平偏移，单位为 Unity 世界单位" value={cameraFollow.offsetX} step={0.1} onChange={(value) => updateCameraFollow({ offsetX: value })} />
            <NumberField label="画面偏移 Y" title="跟随中心相对角色位置的垂直偏移，正数让角色位于画面下方" value={cameraFollow.offsetY} step={0.1} onChange={(value) => updateCameraFollow({ offsetY: value })} />
          </div>
          <label className="toggle-row" title="读取当前场景的 Frame Action 地图尺寸，阻止摄像机视口越过地图边缘"><input type="checkbox" checked={cameraFollow.constrainToMap} onChange={(event) => updateCameraFollow({ constrainToMap: event.target.checked })} /><span>限制在地图范围</span></label>
          {cameraFollow.constrainToMap && <div className="field-grid two-columns">
            <NumberField label="边缘留白 X" title="摄像机视口与地图左右边缘保留的最小世界距离" value={cameraFollow.edgePaddingX} min={0} step={0.1} onChange={(value) => updateCameraFollow({ edgePaddingX: value })} />
            <NumberField label="边缘留白 Y" title="摄像机视口与地图上下边缘保留的最小世界距离" value={cameraFollow.edgePaddingY} min={0} step={0.1} onChange={(value) => updateCameraFollow({ edgePaddingY: value })} />
          </div>}
        </>}
      </section>

      <section className="inspector-section">
        <div className="section-heading"><div><strong>横版角色驱动</strong><span>Input System / 2D Motor</span></div></div>
        <div className="field-grid two-columns">
          <label className="toggle-row" title="使用 Runtime 的 Input System 驱动器读取动作触发按键和方向输入；关闭后可由 AI、网络或项目输入代码调用统一命令接口"><input type="checkbox" checked={motor.enableInput} onChange={(event) => updateMotor({ enableInput: event.target.checked })} /><span>启用标准输入</span></label>
          <label className="toggle-row" title="使用 Runtime 的 FrameActionMotor2D 控制 Rigidbody2D 走跑、跳跃、重力和地面检测；关闭后由项目自有移动代码接管"><input type="checkbox" checked={motor.enableMotor} onChange={(event) => updateMotor({ enableMotor: event.target.checked })} /><span>启用标准运动</span></label>
        </div>
        {motor.enableMotor && <>
          <div className="field-grid two-columns">
            <NumberField label="地面加速度" title="有移动输入时，水平速度每秒接近目标速度的幅度" value={motor.groundAcceleration} min={0.01} step={0.1} onChange={(value) => updateMotor({ groundAcceleration: value })} />
            <NumberField label="地面减速度" title="松开移动输入时，水平速度每秒衰减到 0 的幅度" value={motor.groundDeceleration} min={0.01} step={0.1} onChange={(value) => updateMotor({ groundDeceleration: value })} />
            <NumberField label="空中控制" title="空中水平加减速相对地面的比例；0 表示空中不能改方向，1 表示与地面相同" value={motor.airControl} min={0} max={1} step={0.05} onChange={(value) => updateMotor({ airControl: value })} />
            <NumberField label="重力倍率" title="写入 Rigidbody2D.gravityScale，乘以项目 Physics2D 的全局重力" value={motor.gravityScale} min={0} step={0.1} onChange={(value) => updateMotor({ gravityScale: value })} />
            <NumberField label="最大下落速度" title="角色向下速度的绝对上限，防止持续加速导致穿透或难以控制" value={motor.maxFallSpeed} min={0.01} step={0.1} onChange={(value) => updateMotor({ maxFallSpeed: value })} />
            <NumberField label="离地宽限(秒)" title="角色刚离开平台后仍允许起跳的时间，也称土狼时间" value={motor.coyoteTime} min={0} max={1} step={0.01} onChange={(value) => updateMotor({ coyoteTime: value })} />
            <NumberField label="跳跃缓冲(秒)" title="落地前提前按下跳跃时保留输入的时间，落地后会自动起跳" value={motor.jumpBufferTime} min={0} max={1} step={0.01} onChange={(value) => updateMotor({ jumpBufferTime: value })} />
            <NumberField label="地面检测距离" title="身体碰撞体向下检测地面的额外距离，过小可能漏判斜坡或台阶，过大会提前判定落地" value={motor.groundCheckDistance} min={0.001} step={0.01} onChange={(value) => updateMotor({ groundCheckDistance: value })} />
            <NumberField label="输入死区" title="忽略绝对值低于此值的水平输入，主要用于过滤手柄摇杆漂移" value={motor.inputDeadZone} min={0} max={0.95} step={0.01} onChange={(value) => updateMotor({ inputDeadZone: value })} />
            <label className="field" title="用于地面检测的 Unity Layer 名称；不存在时 Runtime 使用回退 LayerMask"><span>地面 Layer</span><DeferredTextInput value={motor.groundLayerName} onValueChange={(value) => updateMotor({ groundLayerName: value })} /></label>
          </div>
          <label className="toggle-row" title="水平输入方向改变时自动更新角色左右朝向和序列帧镜像"><input type="checkbox" checked={motor.autoFaceMovement} onChange={(event) => updateMotor({ autoFaceMovement: event.target.checked })} /><span>根据移动方向自动朝向</span></label>
        </>}
      </section>
      </>}
      </div>

      <div className="inspector-scope" hidden={scope !== "action"}>
      <section className="inspector-section">
        <div className="section-heading"><div><strong>动作属性</strong><span>{action.id}</span></div></div>
        <div className="field-grid two-columns">
          <label className="field"><span>名称</span><DeferredTextInput value={action.name} onValueChange={(value) => onUpdateAction({ name: value })} /></label>
          <label className="field"><span>ID</span><DeferredTextInput value={action.id} onValueChange={(value) => onUpdateAction({ id: value })} /></label>
          <label className="field"><span>类型</span><select value={action.type} onChange={(event) => {
            const type = event.target.value as CharacterAction["type"];
            onUpdateAction({ type, enemySkill: isEnemy && type === "skill" ? action.enemySkill || createEnemySkillSettings() : undefined });
          }}>
            <option value="idleGround">地面待机</option><option value="idleAir">空中待机</option><option value="move">走路</option>{!isEnemy && <><option value="jump">跳跃</option><option value="dropThrough">下跳</option><option value="attack">普攻</option></>}<option value="skill">技能</option><option value="hurt">受击</option>{!isEnemy && <option value="custom">自定义</option>}
          </select></label>
          {(action.type === "attack" || action.type === "jump") && <NumberField label="段数" value={action.comboCount} min={1} max={20} integer onChange={(value) => onUpdateAction({ comboCount: Math.max(1, Math.round(value)) })} />}
        </div>
        {action.type === "attack" && (
          <div className="field-grid two-columns">
            <NumberField label="连击窗口(秒)" value={action.comboWindow} min={0.01} max={5} step={0.01} onChange={(value) => onUpdateAction({ comboWindow: value })} />
            <NumberField label="重复普攻窗口(秒)" value={action.repeatWindow} min={0.02} max={5} step={0.01} onChange={(value) => onUpdateAction({ repeatWindow: value })} />
            <label className="toggle-row span-two"><input type="checkbox" checked={action.allowLastRepeat} onChange={(event) => onUpdateAction({ allowLastRepeat: event.target.checked })} /><span>最后一段允许重复</span></label>
          </div>
        )}
        {!isEnemy && action.type === "move" && <NumberField label="双击窗口(秒)" value={action.doubleTapWindow} min={0.05} max={1} step={0.01} onChange={(value) => onUpdateAction({ doubleTapWindow: value })} />}
        {!isEnemy && action.type === "move" && <NumberField label={action.trigger.type === "axisDoubleTap" ? "跑步速度" : "移动速度"} title="当前移动动作对应的水平目标速度，单位为 Unity 单位/秒" value={action.movementSpeed} min={0} step={0.1} onChange={(value) => onUpdateAction({ movementSpeed: value })} />}
        <label className="toggle-row"><input type="checkbox" checked={action.loop} onChange={(event) => onUpdateAction({ loop: event.target.checked })} /><span>循环播放</span></label>
      </section>

      {isEnemy && action.type === "skill" && <section className="inspector-section">
        <div className="section-heading"><div><strong>技能释放</strong><span>行为树按技能 ID 选择</span></div></div>
        <div className="field-grid two-columns">
          <NumberField label="冷却时间（秒）" title="技能开始播放时进入独立冷却" value={enemySkill.cooldownSeconds} min={0} step={0.1} onChange={(value) => onUpdateAction({ enemySkill: { ...enemySkill, cooldownSeconds: Math.max(0, value) } })} />
          <NumberField label="选择权重" title="多个技能同时可用时优先选择权重更高的技能" value={enemySkill.selectionWeight} min={0.01} step={0.1} onChange={(value) => onUpdateAction({ enemySkill: { ...enemySkill, selectionWeight: Math.max(0.01, value) } })} />
          <NumberField label="最小释放距离" title="目标过近时该技能不可用" value={enemySkill.minRange} min={0} step={0.1} onChange={(value) => onUpdateAction({ enemySkill: { ...enemySkill, minRange: Math.max(0, Math.min(value, enemySkill.maxRange)) } })} />
          <NumberField label="最大释放距离" title="目标超出该距离时该技能不可用" value={enemySkill.maxRange} min={enemySkill.minRange} step={0.1} onChange={(value) => onUpdateAction({ enemySkill: { ...enemySkill, maxRange: Math.max(enemySkill.minRange, value) } })} />
        </div>
        <label className="toggle-row"><input type="checkbox" checked={enemySkill.lockMovement} onChange={(event) => onUpdateAction({ enemySkill: { ...enemySkill, lockMovement: event.target.checked } })} /><span>释放期间停止移动</span></label>
        <label className="toggle-row"><input type="checkbox" checked={enemySkill.lockFacing} onChange={(event) => onUpdateAction({ enemySkill: { ...enemySkill, lockFacing: event.target.checked } })} /><span>释放期间锁定朝向</span></label>
        <p className="inspector-help">每个技能都是独立动作项，拥有自己的序列帧、时间轴、距离和冷却；无需设置“技能个数”。</p>
      </section>}

      <section className="inspector-section">
        <div className="section-heading"><div><strong>动作段规格</strong><span>{segment.name}</span></div></div>
        <label className="field"><span>动作段名称</span><DeferredTextInput value={segment.name} onValueChange={(value) => onUpdateSegment({ name: value })} /></label>
        <div className="field-grid two-columns">
          <NumberField label="FPS" value={segment.fps} min={1} max={60} integer onChange={(value) => onUpdateSegment({ fps: Math.max(1, Math.round(value)) })} />
          <NumberField label="动作段 PPU" value={segment.pixelsPerUnit} min={1} max={1000} step={0.1} onChange={(value) => onUpdateSegment({ pixelsPerUnit: Math.max(1, value) })} />
          <NumberField label="Pivot X（左起像素）" value={segment.pivotX} min={0} max={8192} step={0.1} onChange={(value) => onUpdateSegment({ pivotX: Math.max(0, value) })} />
          <NumberField label="Pivot Y（底起像素）" value={segment.pivotY} min={0} max={8192} step={0.1} onChange={(value) => onUpdateSegment({ pivotY: Math.max(0, value) })} />
          {action.type === "jump" && <NumberField label="本段跳跃高度" title="当前跳跃动作段触发时希望上升的 Unity 世界高度" value={segment.jumpHeight} min={0.01} step={0.1} onChange={(value) => onUpdateSegment({ jumpHeight: value })} />}
        </div>
      </section>

      {!isEnemy && !idleAction && <section className="inspector-section">
        <div className="section-heading"><div><strong>触发事件</strong><span>保留原模块字段</span></div></div>
        <div className="field-grid two-columns">
          <label className="field"><span>触发类型</span><select value={action.trigger.type} onChange={(event) => { const type = event.target.value; onUpdateAction({ trigger: type === "keyboardChord" ? { type, code: "S", secondaryCode: "K" } : { type, code: TRIGGER_CODE_OPTIONS[type]?.[0]?.[0] || "" } }); }}>
            <option value="none">无</option><option value="keyboard">键盘</option><option value="keyboardChord">键盘组合</option><option value="axisTap">方向单击</option><option value="axisDoubleTap">方向双击</option><option value="mouse">鼠标</option><option value="damage">受到伤害</option><option value="custom">自定义</option>
          </select></label>
          {action.trigger.type !== "none" && <label className="field"><span>{action.trigger.type === "keyboardChord" ? "按键 1" : "触发值"}</span><select value={action.trigger.code} onChange={(event) => { const code = event.target.value; const secondaryCode = action.trigger.type === "keyboardChord" && action.trigger.secondaryCode === code ? (code === "K" ? "S" : "K") : action.trigger.secondaryCode; onUpdateAction({ trigger: { ...action.trigger, code, secondaryCode } }); }}>{triggerOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          {action.trigger.type === "keyboardChord" && <label className="field"><span>按键 2</span><select value={action.trigger.secondaryCode || "K"} onChange={(event) => onUpdateAction({ trigger: { ...action.trigger, secondaryCode: event.target.value } })}>{secondaryTriggerOptions.filter(([value]) => value !== action.trigger.code).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        </div>
      </section>}

      {!isEnemy && <section className="inspector-section">
        <div className="section-heading"><div><strong>转换关系</strong><span>打断 / 缓存 / 忽略</span></div></div>
        <div className="transition-editor-list">
          {project.actions.filter((item) => item.id !== action.id && item.type !== "idleGround" && item.type !== "idleAir").map((target) => (
            <label className="transition-editor-row" key={target.id}>
              <span>{target.name}</span>
              <select
                value={action.transitions[target.id] || "none"}
                onChange={(event) => {
                  const next = { ...action.transitions };
                  if (event.target.value === "none") delete next[target.id];
                  else next[target.id] = event.target.value as "interrupt" | "buffer" | "ignore";
                  onUpdateAction({ transitions: next });
                }}
              >
                <option value="none">无</option><option value="interrupt">打断</option><option value="buffer">缓存</option><option value="ignore">忽略</option>
              </select>
            </label>
          ))}
        </div>
      </section>}
      </div>
    </>
  );
}
