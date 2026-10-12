# UpNet support desk design system

The dashboard is a light-first operational tool for support staff. Its visual
world borrows from variable-type specimens: near-white paper, ink-black
hierarchy, one signal accent, and a dense but calm typographic rhythm. It
favors scanability and clear status communication over decoration.

## Tokens

- Canvas: `#F4F6F8`
- Surface: `#FFFFFF`
- Subtle surface: `#EDF1F3`
- Ink: `#16222D`
- Muted text: `#556372`
- Border: `#D4DDE2`
- Strong border: `#AEBDC5`
- Signal brand: `#0B5F7E`
- Signal hover: `#07435A`
- Focus ring: `#0B5F7E`, 2px with a 2px offset
- Open: `#FFF3D6` with `#8A5A00`
- In progress: `#E4EFFB` with `#1D5A9E`
- Resolved: `#E1F3E9` with `#1B6B43`
- High and urgent: `#FCE8E6` with `#A8271F`

Body text and controls use Public Sans at 12, 13, 14, 16, 20, and 24px.
Dates, identifiers, and counts use tabular numerals. Customer-authored text
uses `dir="auto"` and the system fallback stack remains available for mixed
Urdu and English content.

## Interaction rules

- Inputs and buttons use a 5px radius; panels use 8px.
- Borders provide most of the depth. Shadows are reserved for the detail panel.
- Status badges include text and are never the only status signal.
- Focus states are visible on every interactive control.
- Motion is limited to state changes and is disabled for reduced-motion users.
- The ticket detail timeline is the primary visual focal point.
- The typographic signature is carried by compact uppercase metadata, strong
  ticket references, and restrained letter-spacing rather than decorative
  graphics.
