import { c as createComponent } from './astro-component_D6beqkt_.mjs';
import 'piccolore';
import { o as renderComponent, k as renderTemplate } from './entrypoint_CTHiADAU.mjs';
import { $ as $$BaseLayout } from './BaseLayout_B6VO02J2.mjs';

const prerender = false;
const $$id = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$props, $$slots);
  Astro2.self = $$id;
  const { id } = Astro2.params;
  return renderTemplate`${renderComponent($$result, "BaseLayout", $$BaseLayout, { "title": "Market detail — Sentinel", "data-astro-cid-g2blolvg": true }, { "default": ($$result2) => renderTemplate` ${renderComponent($$result2, "AppShell", null, { "client:only": "react", "page": "market", "marketId": id, "currentPath": "/markets", "client:component-hydration": "only", "data-astro-cid-g2blolvg": true, "client:component-path": "/Users/dhirajhazarika/Desktop/SUI Sentinel/frontend/src/components/AppShell", "client:component-export": "AppShell" })} ` })}`;
}, "/Users/dhirajhazarika/Desktop/SUI Sentinel/frontend/src/pages/markets/[id].astro", void 0);

const $$file = "/Users/dhirajhazarika/Desktop/SUI Sentinel/frontend/src/pages/markets/[id].astro";
const $$url = "/markets/[id]";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$id,
  file: $$file,
  prerender,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
