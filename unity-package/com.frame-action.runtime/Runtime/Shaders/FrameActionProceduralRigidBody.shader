Shader "FrameAction/Procedural Rigid Body"
{
    Properties
    {
        _Tint ("Tint", Color) = (1, 1, 1, 1)
        _Template ("Visual Template", Float) = 0
        _BaseColor ("Base Color", Color) = (0.035, 0.34, 0.62, 1)
        _ShadowColor ("Shadow Color", Color) = (0.014, 0.082, 0.20, 1)
        _HighlightColor ("Highlight Color", Color) = (0.48, 0.89, 1, 1)
        _EdgeColor ("Edge Color", Color) = (0.80, 0.98, 1, 1)
        _FractureColor ("Fracture Effect Color", Color) = (0.90, 0.99, 1, 1)
        _Opacity ("Opacity", Range(0, 1)) = 1
        _AppearanceSeed ("Appearance Seed", Range(0, 1)) = 0
        _TextureStrength ("Texture Strength", Range(0, 1)) = 0.72
        _EdgeBrightness ("Edge Brightness", Range(0, 1)) = 0.88
        _FacetVariation ("Facet Variation", Range(0, 1)) = 0.55
        _VolumeDepth ("Optical Volume Depth", Range(0, 1)) = 0.78
        _Transmission ("Light Transmission", Range(0, 1)) = 0.72
        _Absorption ("Light Absorption", Range(0, 1)) = 0.52
        _EdgeWidthPixels ("Edge Width Pixels", Float) = 1.35
        _Roughness ("Roughness", Range(0, 1)) = 0.16
        _SpecularStrength ("Specular Strength", Range(0, 1)) = 0.82
        _InclusionDensity ("Inclusion Density", Range(0, 1)) = 0.34
        _MicroCrackDensity ("Micro Crack Density", Range(0, 1)) = 0.22
        _GrainDirection ("Grain Direction", Vector) = (0.95, -0.31, 0, 0)
        _Anisotropy ("Anisotropy", Range(0, 1)) = 0.34
        _WorldLightDirection ("World Light Direction", Vector) = (-0.45, 0.50, 0.74, 0)
        _SourceTexture ("Source Texture", 2D) = "white" {}
        _UseSourceTexture ("Use Source Texture", Float) = 0
        _SourceTextureTransform ("Source Texture Transform", Vector) = (0, 0, 0, 0)
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent"
            "RenderType" = "Transparent"
            "IgnoreProjector" = "True"
            "CanUseSpriteAtlas" = "False"
        }

        Cull Off
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha

        Pass
        {
            Name "ProceduralRigid2D"

            CGPROGRAM
            #pragma target 3.0
            #pragma vertex Vert
            #pragma fragment Frag
            #include "UnityCG.cginc"

            struct Attributes
            {
                float4 positionOS : POSITION;
                fixed4 color : COLOR;
                float2 authoringPosition : TEXCOORD0;
                float2 style : TEXCOORD1;
                float2 optical : TEXCOORD2;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                fixed4 color : COLOR;
                float2 authoringPosition : TEXCOORD0;
                float2 style : TEXCOORD1;
                float3 pseudoNormalWS : TEXCOORD2;
                float opticalThickness : TEXCOORD3;
            };

            fixed4 _Tint;
            float _Template;
            fixed4 _BaseColor;
            fixed4 _ShadowColor;
            fixed4 _HighlightColor;
            fixed4 _EdgeColor;
            fixed4 _FractureColor;
            float _Opacity;
            float _AppearanceSeed;
            float _TextureStrength;
            float _EdgeBrightness;
            float _FacetVariation;
            float _VolumeDepth;
            float _Transmission;
            float _Absorption;
            float _EdgeWidthPixels;
            float _Roughness;
            float _SpecularStrength;
            float _InclusionDensity;
            float _MicroCrackDensity;
            float4 _GrainDirection;
            float _Anisotropy;
            float4 _WorldLightDirection;
            sampler2D _SourceTexture;
            float _UseSourceTexture;
            float4 _SourceTextureTransform;

            float Hash21(float2 value)
            {
                value = frac(value * float2(123.34, 456.21));
                value += dot(value, value + 45.32 + _AppearanceSeed * 71.37);
                return frac(value.x * value.y);
            }

            float ValueNoise(float2 value)
            {
                float2 cell = floor(value);
                float2 local = frac(value);
                local = local * local * (3.0 - 2.0 * local);
                float a = Hash21(cell);
                float b = Hash21(cell + float2(1.0, 0.0));
                float c = Hash21(cell + float2(0.0, 1.0));
                float d = Hash21(cell + float2(1.0, 1.0));
                return lerp(lerp(a, b, local.x), lerp(c, d, local.x), local.y);
            }

            float Fbm(float2 value)
            {
                float result = ValueNoise(value) * 0.57;
                result += ValueNoise(value * 2.03 + 13.17) * 0.29;
                result += ValueNoise(value * 4.11 - 7.93) * 0.14;
                return result;
            }

            // Returns the gap between the closest two deterministic authoring-space feature
            // points. A small gap forms a natural cellular micro-crack. There is deliberately no
            // body pivot or radial coordinate in this calculation.
            float CellularEdge(float2 value)
            {
                float2 baseCell = floor(value);
                float2 local = frac(value);
                float nearest = 10.0;
                float second = 10.0;
                [unroll]
                for (int y = -1; y <= 1; y++)
                {
                    [unroll]
                    for (int x = -1; x <= 1; x++)
                    {
                        float2 cell = float2(x, y);
                        float2 id = baseCell + cell;
                        float2 feature = cell + float2(Hash21(id), Hash21(id + 31.73)) - local;
                        float distanceSquared = dot(feature, feature);
                        if (distanceSquared < nearest)
                        {
                            second = nearest;
                            nearest = distanceSquared;
                        }
                        else if (distanceSquared < second)
                        {
                            second = distanceSquared;
                        }
                    }
                }
                return sqrt(second) - sqrt(nearest);
            }

            Varyings Vert(Attributes input)
            {
                Varyings output;
                output.positionCS = UnityObjectToClipPos(input.positionOS);
                output.color = input.color * _Tint;
                output.authoringPosition = input.authoringPosition;
                output.style = input.style;
                output.opticalThickness = input.optical.x;

                float angle = input.style.y * 6.28318530718;
                float tilt = lerp(0.23, 0.63, _FacetVariation);
                float3 normalOS = normalize(float3(cos(angle) * tilt, sin(angle) * tilt, 1.0));
                output.pseudoNormalWS = normalize(mul((float3x3)unity_ObjectToWorld, normalOS));
                return output;
            }

            fixed4 Frag(Varyings input) : SV_Target
            {
                fixed4 color = input.color;
                float style = input.style.x;

                // Object-library rigid bodies retain the exact source-image appearance.
                // Authoring-space coordinates are immutable across fracture, so every child
                // fragment samples the same source pixel that occupied that point on the mother.
                if (style < 0.5 && _UseSourceTexture > 0.5)
                {
                    float2 sourceUv = input.authoringPosition * _SourceTextureTransform.xy
                        + _SourceTextureTransform.zw;
                    fixed4 sampled = tex2D(_SourceTexture, sourceUv);
                    color.rgb = sampled.rgb * _Tint.rgb;
                    color.a *= sampled.a * _Opacity;
                    return color;
                }

                if (style < 0.5)
                {
                    float2 p = input.authoringPosition;
                    float2 seedOffset = float2(_AppearanceSeed * 173.1, _AppearanceSeed * -91.7);
                    float macroCloud = Fbm(p * 0.0105 + seedOffset);
                    float middleCloud = Fbm(p * 0.0310 + seedOffset * 0.47 + 17.3);
                    float fineCloud = ValueNoise(p * 0.118 + seedOffset * 1.31);
                    float warp = (macroCloud - 0.5) * 18.0;
                    float2 grainDirection = normalize(_GrainDirection.xy + float2(0.0001, 0.0002));
                    float2 crossGrain = float2(-grainDirection.y, grainDirection.x);
                    float layerA = 0.5 + 0.5 * sin(dot(p, grainDirection) * 0.040 + warp);
                    float layerB = 0.5 + 0.5 * sin(dot(p, crossGrain) * 0.023 - warp * 0.63);
                    float opticalDensity = saturate(0.20 + macroCloud * 0.56 + middleCloud * 0.24
                        + layerA * 0.12 + layerB * 0.08);
                    float localThickness = lerp(0.25, 1.0, saturate(input.opticalThickness));
                    float attenuation = exp2(-_Absorption * _VolumeDepth * localThickness * (1.1 + opticalDensity * 3.4));
                    float3 lightDirection = normalize(_WorldLightDirection.xyz);
                    float3 normalDirection = normalize(input.pseudoNormalWS);
                    float diffuse = saturate(dot(normalDirection, lightDirection));
                    float3 halfDirection = normalize(lightDirection + float3(0.0, 0.0, 1.0));
                    float specularExponent = lerp(112.0, 10.0, _Roughness);
                    float specular = pow(saturate(dot(normalDirection, halfDirection)), specularExponent);
                    // `template` is reserved by some D3D11 HLSL compilers. A compile failure
                    // turns the narrow seam quads into Unity's magenta error material.
                    float templateIndex = floor(_Template + 0.5);
                    fixed3 body;

                    if (templateIndex < 0.5)
                    {
                        // iceCrystal: multi-scale absorption/transmission in immutable authoring
                        // coordinates. No body pivot or centre participates in this field.
                        body = lerp(_ShadowColor.rgb, color.rgb, 0.34 + attenuation * 0.50);
                        body = lerp(body, _BaseColor.rgb, _Transmission * attenuation * (0.22 + layerA * 0.22));
                        body = lerp(body, _HighlightColor.rgb, _Transmission * attenuation * layerB * 0.15);
                    }
                    else if (templateIndex < 1.5)
                    {
                        // wood: directional fibres plus broad growth variation.
                        float grain = 0.5 + 0.5 * sin(dot(p, grainDirection) * lerp(0.12, 0.30, _Anisotropy)
                            + macroCloud * 9.0);
                        float pores = smoothstep(0.76, 0.94, fineCloud) * _InclusionDensity;
                        body = lerp(_ShadowColor.rgb, _BaseColor.rgb, saturate(0.22 + middleCloud * 0.56 + grain * 0.28));
                        body = lerp(body, _HighlightColor.rgb, grain * 0.18 * _TextureStrength);
                        body *= 1.0 - pores * 0.28;
                    }
                    else if (templateIndex < 2.5)
                    {
                        // metal: coherent brushed anisotropy and tight world-lit highlights.
                        float brush = ValueNoise(float2(dot(p, grainDirection) * 0.19,
                            dot(p, crossGrain) * lerp(0.006, 0.045, 1.0 - _Anisotropy)) + seedOffset);
                        body = lerp(_ShadowColor.rgb, _BaseColor.rgb, 0.46 + brush * 0.34);
                        body = lerp(body, _HighlightColor.rgb, specular * _SpecularStrength * (0.46 + _Anisotropy * 0.44));
                    }
                    else if (templateIndex < 3.5)
                    {
                        // stone: rough low-frequency body with sparse mineral inclusions.
                        float mineral = smoothstep(0.82, 0.97, fineCloud) * _InclusionDensity;
                        body = lerp(_ShadowColor.rgb, _BaseColor.rgb, 0.24 + macroCloud * 0.58);
                        body = lerp(body, _HighlightColor.rgb, middleCloud * 0.14 + mineral * 0.28);
                    }
                    else
                    {
                        body = lerp(_ShadowColor.rgb, _BaseColor.rgb, 0.25 + macroCloud * 0.60);
                        body = lerp(body, _HighlightColor.rgb, fineCloud * _TextureStrength * 0.16);
                    }

                    float facetLight = lerp(0.70, 1.22, diffuse);
                    body *= lerp(1.0, facetLight, 0.48 + _VolumeDepth * 0.34);
                    body += specular * _SpecularStrength * _HighlightColor.rgb
                        * lerp(0.20, 0.80, 1.0 - _Roughness);
                    float cellEdge = CellularEdge(p * 0.040 + seedOffset * 0.13 + macroCloud * 0.8);
                    float microCrack = (1.0 - smoothstep(0.018, 0.075, cellEdge))
                        * smoothstep(0.41, 0.82, middleCloud)
                        * _MicroCrackDensity;
                    float inclusionCell = Hash21(floor(p * 0.155 + seedOffset));
                    float inclusion = smoothstep(1.0 - _InclusionDensity * 0.18, 0.998, inclusionCell)
                        * smoothstep(0.45, 0.92, fineCloud);
                    body = lerp(body, _HighlightColor.rgb, microCrack * lerp(0.22, 0.72, 1.0 - _Roughness));
                    body = lerp(body, _HighlightColor.rgb, inclusion * 0.46);
                    float fineTexture = lerp(0.90, 1.10, fineCloud);
                    color.rgb = body * lerp(1.0, fineTexture, _TextureStrength * 0.42);
                }
                else if (style < 1.5)
                {
                    // Structural facet seam.
                    float seamVariation = ValueNoise(input.authoringPosition * 0.075 + input.style.y * 19.0);
                    color.rgb *= lerp(0.66, 1.10 + seamVariation * 0.12, _EdgeBrightness);
                }
                else if (style < 2.5)
                {
                    float edgeNoise = Fbm(input.authoringPosition * 0.062 + _AppearanceSeed * 43.0);
                    fixed3 rim = lerp(_BaseColor.rgb, _EdgeColor.rgb, edgeNoise);
                    color.rgb = lerp(color.rgb, rim,
                        saturate(0.50 + _EdgeBrightness * 0.36 + saturate(_EdgeWidthPixels / 6.0) * 0.10));
                }
                else
                {
                    // Explicit damage crack geometry remains legible over every optical layer.
                    float crackSpark = ValueNoise(input.authoringPosition * 0.17 + _AppearanceSeed * 67.0);
                    color.rgb = lerp(color.rgb, _FractureColor.rgb, 0.74 + crackSpark * 0.18);
                }

                color.rgb = saturate(color.rgb);
                color.a *= _Opacity;
                return color;
            }
            ENDCG
        }
    }

    FallBack Off
}
