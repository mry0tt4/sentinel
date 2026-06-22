import { c as createComponent } from './astro-component_D6beqkt_.mjs';
import 'piccolore';
import { p as renderHead, q as renderSlot, k as renderTemplate } from './entrypoint_CTHiADAU.mjs';
import 'clsx';

const $$BaseLayout = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$props, $$slots);
  Astro2.self = $$BaseLayout;
  const { title = "Sentinel Risk Guardian" } = Astro2.props;
  return renderTemplate`<html lang="en"> <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="description" content="AI-assisted, bounded autonomous risk control for Sui DeFi markets."><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preconnect" href="https://api.fontshare.com" crossorigin><link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap"><title>${title}</title>${renderHead()}</head> <body> ${renderSlot($$result, $$slots["default"])}    </body> </html>`;
}, "/Users/dhirajhazarika/Desktop/SUI Sentinel/frontend/src/layouts/BaseLayout.astro", void 0);

export { $$BaseLayout as $ };
