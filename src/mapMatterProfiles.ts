import type {
  MapMatterAuthoringProfileData,
  MapMatterPhysicalProfileData,
  MapMatterVisualProfileData,
} from "./mapTypes";

const LEGACY_COLORS: Record<string, string> = {
  fire: "#ff542c",
  ice: "#65cdf2",
  water: "#287bd8",
  wind: "#7be1ba",
  light: "#ffe174",
  dark: "#5a2d82",
  thunder: "#ad68ff",
};

export function defaultMatterVisual(elementTag: string): MapMatterVisualProfileData {
  const baseColor = LEGACY_COLORS[elementTag.trim().toLowerCase()] || "#44aee8";
  return {
    baseColor,
    secondaryColor: baseColor,
    emissionColor: "#000000",
    opacity: 0.78,
    particleScale: 1,
    edgeSoftness: 0.28,
    detailScale: 1,
    refractionStrength: 0.12,
    glowStrength: 0,
    foamAmount: 0.08,
  };
}

export function defaultMatterPhysical(carrier: "liquid" | "gas"): MapMatterPhysicalProfileData {
  return carrier === "gas" ? {
    density: 0.85,
    viscosity: 0.08,
    surfaceTension: 0,
    flowSpeed: 1,
    gravityScale: 0,
    diffusion: 0.42,
    buoyancy: 0.22,
    drag: 0.08,
    evaporationHalfLifeSeconds: 0,
    dissipationHalfLifeSeconds: 1200,
  } : {
    density: 1,
    viscosity: 0.18,
    surfaceTension: 0.34,
    flowSpeed: 1,
    gravityScale: 1,
    diffusion: 0.02,
    buoyancy: 0,
    drag: 0.04,
    evaporationHalfLifeSeconds: 1200,
    dissipationHalfLifeSeconds: 0,
  };
}

export function createMatterProfile(
  carrier: "liquid" | "gas",
  elementTag: string,
): MapMatterAuthoringProfileData {
  return {
    schemaVersion: 1,
    visual: defaultMatterVisual(elementTag),
    physical: defaultMatterPhysical(carrier),
  };
}

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function color(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

export function normalizeMatterProfile(
  carrier: "liquid" | "gas",
  elementTag: string,
  profile: Partial<MapMatterAuthoringProfileData> | null | undefined,
): MapMatterAuthoringProfileData {
  const defaults = createMatterProfile(carrier, elementTag);
  const visual = profile?.visual || defaults.visual;
  const physical = profile?.physical || defaults.physical;
  return {
    schemaVersion: 1,
    visual: {
      baseColor: color(visual.baseColor, defaults.visual.baseColor),
      secondaryColor: color(visual.secondaryColor, defaults.visual.secondaryColor),
      emissionColor: color(visual.emissionColor, defaults.visual.emissionColor),
      opacity: finite(visual.opacity, defaults.visual.opacity, 0, 1),
      particleScale: finite(visual.particleScale, defaults.visual.particleScale, 0.1, 4),
      edgeSoftness: finite(visual.edgeSoftness, defaults.visual.edgeSoftness, 0, 1),
      detailScale: finite(visual.detailScale, defaults.visual.detailScale, 0.1, 8),
      refractionStrength: finite(visual.refractionStrength, defaults.visual.refractionStrength, 0, 1),
      glowStrength: finite(visual.glowStrength, defaults.visual.glowStrength, 0, 8),
      foamAmount: finite(visual.foamAmount, defaults.visual.foamAmount, 0, 1),
    },
    physical: {
      density: finite(physical.density, defaults.physical.density, 0.001, 100),
      viscosity: finite(physical.viscosity, defaults.physical.viscosity, 0, 8),
      surfaceTension: finite(physical.surfaceTension, defaults.physical.surfaceTension, 0, 4),
      flowSpeed: finite(physical.flowSpeed, defaults.physical.flowSpeed, 0.05, 8),
      gravityScale: finite(physical.gravityScale, defaults.physical.gravityScale, -4, 4),
      diffusion: finite(physical.diffusion, defaults.physical.diffusion, 0, 4),
      buoyancy: finite(physical.buoyancy, defaults.physical.buoyancy, -4, 4),
      drag: finite(physical.drag, defaults.physical.drag, 0, 8),
      evaporationHalfLifeSeconds: finite(physical.evaporationHalfLifeSeconds, defaults.physical.evaporationHalfLifeSeconds, 0, 86400),
      dissipationHalfLifeSeconds: finite(physical.dissipationHalfLifeSeconds, defaults.physical.dissipationHalfLifeSeconds, 0, 86400),
    },
  };
}
