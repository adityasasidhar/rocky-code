/**
 * Bun compiles JSX React-style by default, which silently breaks Solid's
 * reactivity. The bunfig preload registers Solid's transform plugin for every
 * normal launch, but a globally-installed bin skips bunfig — so every entry
 * into the footer app goes through here first, and only then dynamically
 * imports a .tsx file. Registration is idempotent.
 */
export async function ensureSolidJsx(): Promise<void> {
  const mod = await import("@opentui/solid/bun-plugin");
  mod.ensureSolidTransformPlugin();
}
