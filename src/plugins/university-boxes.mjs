// EmDash plugin: the note boxes (asides) and collapsible sections (details) of
// eTop University, as editor blocks.
//
// Each box is stored flat (scripts/emdash/lib/md-to-pt.mjs, flattenBoxes): a
// start marker, the box's content as ordinary blocks the editor can change, and
// an end marker. This plugin gives the four markers a name, an icon and a form
// in the editor (type a "/" to insert one); the site theme (src/lib/pt.ts) draws
// the box. No server code, no storage, no capabilities.
import { fileURLToPath } from "node:url";

const VARIANTS = [
  { label: "Note (blue)", value: "note" },
  { label: "Tip (green)", value: "tip" },
  { label: "Caution (orange)", value: "caution" },
  { label: "Danger (red)", value: "danger" },
];

export const BOX_BLOCKS = [
  {
    type: "asideStart",
    label: "Note box: start",
    description: "Starts a coloured note box. Put the text after it, then add \"Note box: end\".",
    icon: "form",
    category: "Boxes",
    fields: [
      { type: "select", action_id: "variant", label: "Kind of box", options: VARIANTS, initial_value: "note" },
      { type: "text_input", action_id: "title", label: "Title (optional)", placeholder: "Leave empty for the default title" },
    ],
  },
  {
    type: "asideEnd",
    label: "Note box: end",
    description: "Ends the note box above it.",
    icon: "form",
    category: "Boxes",
    fields: [{ type: "select", action_id: "closes", label: "Ends", options: [{ label: "the note box above", value: "aside" }], initial_value: "aside" }],
  },
  {
    type: "detailsStart",
    label: "Collapsible section: start",
    description: "Starts a section readers click to open. Put the text after it, then add \"Collapsible section: end\".",
    icon: "form",
    category: "Boxes",
    fields: [{ type: "text_input", action_id: "summary", label: "Heading readers click", placeholder: "e.g. Link to the App Store" }],
  },
  {
    type: "detailsEnd",
    label: "Collapsible section: end",
    description: "Ends the collapsible section above it.",
    icon: "form",
    category: "Boxes",
    fields: [{ type: "select", action_id: "closes", label: "Ends", options: [{ label: "the collapsible section above", value: "details" }], initial_value: "details" }],
  },
];

/** Plugin descriptor for `emdash({ plugins: [universityBoxes()] })` in astro.config.mjs. */
export function universityBoxes() {
  return {
    id: "university-boxes",
    version: "1.0.0",
    format: "standard",
    // Absolute path with forward slashes: EmDash writes it into an import statement.
    entrypoint: fileURLToPath(new URL("./university-boxes.entry.mjs", import.meta.url)).replaceAll("\\", "/"),
    portableTextBlocks: BOX_BLOCKS,
  };
}
