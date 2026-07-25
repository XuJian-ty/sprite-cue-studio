# SpriteCue Studio

SpriteCue Studio 是面向横版 2D 游戏的动作编辑工具，可集中处理角色、敌人、地图配置，并将结果同步到 Unity。

## 核心功能

- **动作编辑**：导入 PNG 序列或 Sprite Sheet，配置动作片段、连段、转换条件，在时间轴中编辑命中、特效、音效、位移、镜头事件。
- **敌人配置**：制作敌人动作和技能，使用行为树配置巡逻、追击、技能释放、受击逻辑。
- **地图编辑**：摆放背景和场景物体，绘制碰撞轮廓、遮挡区域、单向平台，配置移动物体。
- **实时预览**：预览序列帧、命中范围、运动路径、目标受击、事件时序。
- **Unity 同步**：绑定 Unity 项目，同步角色、敌人、地图数据，创建或更新 Prefab；Runtime 由 Unity Package Manager 独立管理。

## 本地运行

```powershell
npm install
npm run dev
```

生产模式：

```powershell
npm run build
npm start
```

## Unity 同步

首次绑定前，通过 Unity Package Manager 的 **Add package from git URL** 安装：

```text
https://github.com/x32649/sprite-cue-studio.git?path=/unity-package/com.frame-action.runtime
```

也可以选择 **Add package from disk**，打开仓库内的 `unity-package/com.frame-action.runtime/package.json`。

安装完成后，在工具中选择包含 `Assets`、`Packages`、`ProjectSettings` 的 Unity 项目根目录。工具会读取 Runtime 的 Schema 兼容范围，兼容时可同步角色、敌人和地图数据。后续每次同步都会重新检查兼容性。同步过程不会安装、升级或覆盖 Runtime 文件，项目对 Runtime C# 的自定义修改会保留。
