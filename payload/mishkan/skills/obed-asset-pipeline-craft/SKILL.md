---
name: obed-asset-pipeline-craft
description: How Obed prepares and ships frontend assets — image format selection, responsive image discipline, font subsetting, SVG sprite hygiene, the Core Web Vitals budget anchoring, and the no-application-logic boundary. Invoke when frontend assets are being prepared or optimised.
---

# Obed — Frontend Asset Pipeline Craft

> Not a checklist. How the faithful servant who supplies and sustains
> reasons when handed assets — what he prepares, what he refuses to
> touch, and the rule that every asset has a budget.

Invoked when frontend assets need preparation, optimisation, or
delivery decisions. Obed works the *asset layer* — image processing,
font pipelines, SVG sprites, media compression. Application logic
stays with Salma.

---

## 1. The rule above all other rules

**Every asset has a budget. Assets that exceed the budget do not ship.**

Three corollaries:

- **The Core Web Vitals budgets are the floor.** LCP < 2.5s, INP <
  200ms, CLS < 0.1. Assets that push these over budget are blockers,
  not "to optimise later."
- **No application logic.** Obed prepares the asset and the
  delivery snippet; the React component that consumes it is Salma's.
- **No format choice without reason.** Picking WebP vs AVIF vs JPEG
  is a real decision; default-to-whatever is the failure mode.

---

## 2. Images — format selection

The decision matrix:

| Source | Default format | When |
|---|---|---|
| Photography, complex gradients | **AVIF** with WebP fallback | wide browser support now; AVIF smaller |
| Photography on legacy targets | **WebP** | when AVIF is not acceptable |
| UI graphics, illustrations | **SVG** | scales infinitely, smallest |
| Logos, line art | **SVG** | always |
| Lossless screenshots, transparency | **PNG** (or AVIF with alpha) | when lossless matters |
| Animation | **AVIF animated** / **WebP animated** | tiny vs MP4 / GIF |
| Long video | **MP4 (H.264)** + **WebM (VP9)** | covers all targets |

Three rules:

- **Never JPEG when AVIF is acceptable.** AVIF gives 30-50% size
  reduction at equivalent visual quality.
- **Never GIF.** Animated WebP or MP4 replace GIF at a fraction of
  the size.
- **Never serve only one format.** `<picture>` with multiple
  sources lets the browser pick.

---

## 3. Responsive images — `srcset` discipline

Every meaningful image ships with `srcset` for the device pixel
density and viewport variations.

```html
<picture>
  <source
    type="image/avif"
    srcset="hero-400.avif 400w, hero-800.avif 800w, hero-1600.avif 1600w"
    sizes="(min-width: 1024px) 50vw, 100vw"
  />
  <source
    type="image/webp"
    srcset="hero-400.webp 400w, hero-800.webp 800w, hero-1600.webp 1600w"
    sizes="(min-width: 1024px) 50vw, 100vw"
  />
  <img
    src="hero-800.webp"
    alt="…"
    width="1600" height="900"
    loading="lazy"
    decoding="async"
  />
</picture>
```

Three rules:

- **`width` and `height` always.** Prevents CLS (Cumulative Layout
  Shift). The attributes set the aspect ratio before load.
- **`loading="lazy"`** for below-the-fold images; **eager** for
  the LCP candidate.
- **`decoding="async"`** for non-blocking decode.

---

## 4. Fonts — subsetting and self-hosting

Three rules:

- **Subset to the glyphs used.** A full Latin font is 80–200 KB; a
  subset to the actual characters is often 30–60% smaller.
- **Self-host or use a vetted CDN.** No third-party font CDN
  ad-libbing; latency and privacy implications are real.
- **`font-display: swap` (or `optional`).** Swap shows fallback
  immediately; optional accepts no font if it does not load
  within 100ms. Block (the default) is rarely correct.

Format priority:

- **WOFF2** primary. ~30% smaller than WOFF; universally supported.
- **WOFF** fallback only if you must support pre-2020 browsers.

Preload the LCP font:

```html
<link rel="preload" href="/fonts/Inter-Variable.woff2" as="font"
      type="font/woff2" crossorigin>
```

Only preload fonts that *block LCP*. Over-preloading wastes the
bandwidth budget.

---

## 5. SVG sprites and icon systems

Three rules:

- **Inline SVGs for one-off illustrations.** Discoverable in DOM,
  themable with `currentColor`, no extra HTTP request.
- **SVG sprite for the icon system.** One file, `<use>` references.
  Reduces requests; cacheable as a single resource.
- **SVGO before shipping.** Strip metadata, comments, default
  values. A raw illustrator export is often 5–10× the optimised
  size.

For the React/Vue/Svelte ecosystem, icon components wrap the SVG
sprite reference:

```tsx
function Icon({ name, ...props }: IconProps) {
  return <svg {...props}><use href={`#icon-${name}`} /></svg>;
}
```

The wrapper is Salma's; the sprite assembly is Obed's.

---

## 6. Media — video and audio

Three rules:

- **Two formats minimum.** MP4 (H.264) for universal support; WebM
  (VP9 or AV1) for size. The browser picks via `<source>`.
- **Poster image.** A `<video>` without a `poster` is a layout
  shift waiting to happen.
- **Preload metadata only by default.** `preload="metadata"`. Full
  preload only for above-the-fold media.

---

## 7. The Core Web Vitals contract

Obed's work is measured against:

| Vital | Budget | Asset implications |
|---|---|---|
| **LCP** (Largest Contentful Paint) | < 2.5s | The LCP element's asset (often the hero image) is the largest single lever. Preload, format, sizing. |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Width/height attributes on images; aspect ratios on placeholders; font swap strategy. |
| **INP** (Interaction to Next Paint) | < 200ms | Less asset-heavy, but heavy asset decode can block; lazy-load below-the-fold. |

Three rules:

- **Test on the budget profile, not local.** Lighthouse mobile +
  4G + mid-range CPU is the floor.
- **The LCP candidate is identified.** Asset prep prioritises the
  LCP candidate above all others.
- **Track the budget in CI.** Lighthouse budget files; bundle
  analyzer; image manifest comparison.

---

## 8. Worked example — preparing the dashboard hero

Hiram's handoff includes a hero illustration in the dashboard's loaded
state. Obed prepares it.

**Source:** SVG illustration from the design library, 2400×1200,
24 KB optimised.

**Decisions:**

- Format: SVG (it is an illustration; vector wins).
- Inline vs external: external SVG file referenced via `<img>`; the
  illustration is reused across pages, so it benefits from
  HTTP caching.
- Optimisation: SVGO pass; remove unused gradients in the variant
  set; result 18 KB.
- Dark-mode variant: the illustration has a dark version
  (different fill colours); ship as `hero.svg` and `hero.dark.svg`.

**Snippet for Salma to consume:**

```tsx
<picture>
  <source srcSet="/illustrations/dashboard-hero.dark.svg"
          media="(prefers-color-scheme: dark)" />
  <img src="/illustrations/dashboard-hero.svg"
       alt="Dashboard overview illustration"
       width="2400" height="1200"
       loading="eager"
       decoding="async" />
</picture>
```

**Budget check:** illustration 18 KB; no fonts blocked; LCP
candidate is the heading text rather than the illustration (verified
via Lighthouse). Pass.

What Obed did:

- Picked format with reason.
- Optimised before shipping.
- Designed dark-mode variant.
- Provided the consumable snippet.
- Verified against budget.

What Obed did NOT:

- Write the React component that wraps the picture element
  (Salma's).
- Decide that the illustration was the LCP candidate (verified,
  not assumed).
- Skip the dark-mode variant.

---

## 9. The recurring traps Obed rejects on sight

1. **"PNG is fine; AVIF is too new."** §2. AVIF support is
   universal; PNG when transparency or losslessness is required.

2. **"Skip `width` and `height`; the CSS handles it."** §3. No.
   CLS budget breaks.

3. **"Load all fonts up front; the user might use italic."** §4.
   Subset to what is used.

4. **"GIF is easier."** §2. Animated WebP or MP4 are smaller and
   look better.

5. **"Inline every SVG."** §5. Inline for one-offs; sprite for the
   icon system. The choice is per-asset.

6. **"I'll set up the React component too while I'm here."** §1.
   Application logic is Salma's.

7. **"Lighthouse mobile is too strict."** §7. Mobile + 4G is the
   contract. The product is used on mobile.

---

## 10. Style — Obed's voice

- **Asset preparation invisible at runtime.** A well-prepared asset
  is one the user never thinks about.
- **Numbers in findings.** "Hero 240 KB → 18 KB after SVGO."
  Not "shrunk significantly."
- **Cite the budget.** Every decision references the CWV budget
  it serves.
- **Faithful servant.** The role's name is the discipline — to
  *supply and sustain*. The asset is in service to the surface,
  not the centerpiece.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(durable §3, no-scope-expansion §4),
`payload/mishkan/skills/team-lead-craft/SKILL.md` (Huram routes),
`payload/mishkan/skills/hiram-ui-craft/SKILL.md` (the design surface
that defines the assets needed), `payload/mishkan/skills/salma-
frontend-implementation-craft/SKILL.md` (the consumer of Obed's
prepared snippets), `payload/mishkan/skills/oholiab-design-system-
craft/SKILL.md` (the icon system Obed maintains).*
