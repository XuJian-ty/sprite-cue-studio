// Compatibility shader name for projects authored before program-rigid templates.
Shader "FrameAction/Procedural Ice Body"
{
    Properties
    {
        _Tint ("Tint", Color) = (1,1,1,1)
        _Template ("Visual Template", Float) = 0
        _BaseColor ("Base Color", Color) = (0.035,0.34,0.62,1)
        _ShadowColor ("Shadow Color", Color) = (0.014,0.082,0.20,1)
        _HighlightColor ("Highlight Color", Color) = (0.48,0.89,1,1)
        _EdgeColor ("Edge Color", Color) = (0.80,0.98,1,1)
        _Opacity ("Opacity", Range(0,1)) = 1
        _AppearanceSeed ("Appearance Seed", Range(0,1)) = 0
        _TextureStrength ("Texture Strength", Range(0,1)) = 0.72
        _EdgeBrightness ("Edge Brightness", Range(0,1)) = 0.88
        _FacetVariation ("Facet Variation", Range(0,1)) = 0.55
        _VolumeDepth ("Volume Depth", Range(0,1)) = 0.78
        _Transmission ("Transmission", Range(0,1)) = 0.72
        _Absorption ("Absorption", Range(0,1)) = 0.52
        _EdgeWidthPixels ("Edge Width Pixels", Float) = 1.35
        _Roughness ("Roughness", Range(0,1)) = 0.16
        _SpecularStrength ("Specular Strength", Range(0,1)) = 0.82
        _InclusionDensity ("Inclusion Density", Range(0,1)) = 0.34
        _MicroCrackDensity ("Micro Crack Density", Range(0,1)) = 0.22
        _GrainDirection ("Grain Direction", Vector) = (0.95,-0.31,0,0)
        _Anisotropy ("Anisotropy", Range(0,1)) = 0.34
        _WorldLightDirection ("World Light Direction", Vector) = (-0.45,0.50,0.74,0)
    }
    SubShader { UsePass "FrameAction/Procedural Rigid Body/ProceduralRigid2D" }
    FallBack Off
}

