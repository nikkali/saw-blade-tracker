// The production route. Changing the process means changing this list: every
// screen, count and rule below reads from it. Corrected from the shop videos.
// The route, from the shop walkthrough, 2026-11-03 and 2026-11-05.
// `only` limits a step to some kinds of blade. `machine` asks which machine did it.
const BUILT = ['NEW', 'REFURB'];
// The board shows these columns; the steps are the checkboxes on each job card.
export const STAGES = [
  { id: 'hold', label: 'Hold' },
  { id: 'prep', label: 'Prep' },
  { id: 'tipping', label: 'Tipping' },
  { id: 'finishing', label: 'Finishing' },
  { id: 'ship_out', label: 'Ship Out' },
];
export const STEPS = [
  { id: 'remove_tips', stage: 'prep', label: 'Remove old tips', verb: 'Old tips off', only: ['REFURB'], machine: true, hint: 'Done in Saw Shop 1.' },
  { id: 'flatten', stage: 'prep', label: 'Flatten (roller)', verb: 'Flattened', only: ['REFURB'], machine: true, hint: 'Mahatma roller: takes out the dips and bends.' },
  { id: 'polish', stage: 'prep', label: 'Polish', verb: 'Polished', only: ['REFURB'], machine: true, machines: ['HBPM-01'] },
  { id: 'blank_check', stage: 'prep', label: 'Blank check', verb: 'Blank checked', only: ['REFURB'], hint: 'Before tipping: clean, no slag or old weld, no tips, flat. If it fails, open the blade and scrap it or send it back.' },
  // Serial first, so the blade carries its number through everything else (Nik, 2026-11-05).
  { id: 'laser', stage: 'prep', label: 'Laser serial', verb: 'Lasered', machine: true },
  { id: 'wash_in', stage: 'prep', label: 'Wash blank', verb: 'Washed', only: BUILT, machine: true, hint: 'Takes the oil off so it does not contaminate the weld.' },
  { id: 'tipping', stage: 'tipping', label: 'Tipping', verb: 'Tipped', only: BUILT, machine: true, machines: ['HBCW-01'] },
  { id: 'side_grind', stage: 'finishing', label: 'Grind sides', verb: 'Sides ground', only: BUILT, machine: true, machines: ['HBSGM-01'], hint: 'Sides first.' },
  { id: 'face_grind', stage: 'finishing', label: 'Grind face', verb: 'Face ground', only: BUILT, machine: true },
  { id: 'top_grind', stage: 'finishing', label: 'Grind top', verb: 'Top ground', only: BUILT, machine: true, hint: 'Top always last, for a clean edge.' },
  { id: 'wash_out', stage: 'finishing', label: 'Final wash', verb: 'Final wash done', machine: true, hint: 'Three stages. The last one adds the anti-corrosion coat.' },
  { id: 'dip', stage: 'finishing', label: 'Dip tips', verb: 'Tips dipped' },
  { id: 'crate', stage: 'ship_out', label: 'Crate', verb: 'Crated' },
  { id: 'ship', stage: 'ship_out', label: 'Ship', verb: 'Shipped' },
  { id: 'deliver', stage: 'ship_out', label: 'Delivery', verb: 'Delivered' },
];
export const STEP_IDS = STEPS.map((s) => s.id);
export const CONDITIONS = [
  { value: 'NEW', label: 'New build' },
  { value: 'RESALE', label: 'Bought finished' },
  { value: 'REFURB', label: 'Refurbished' },
];
// Records from before this field existed are all new blades.
export const conditionOf = (blade) => blade.condition || 'NEW';
export const routeFor = (condition) => STEPS.filter((s) => !s.only || s.only.includes(condition)).map((s) => s.id);
export const DONE = 'delivered';
export const SCRAPPED = 'scrapped';

// Each series counts on its own: ND for new and bought-finished blades, RD for refurbished (Nik, 2026-11-05).
export const SERIAL = { prefix: 'ND', digits: 7, refurbPrefix: 'RD' };
export const prefixFor = (condition) => (condition === 'REFURB' ? SERIAL.refurbPrefix : SERIAL.prefix);

// Read off the laser design on screen; confirm against the file.
export const SPEC = {
  line1: 'HELANBAK',
  line2: '24" X 72 T ATB',
  line3: '1.5"b x .180" p',
  line4: '3400 MAX RPM',
};

export const TYPES = ['SLOTTED', 'SOLID'];
export const MAKERS = ['POPULAR', 'EC'];
export const CARRIERS = ['UPS', 'Driver delivering', 'Delivered by us', 'Customer pickup', 'Freight'];

export const config = { STAGES, STEPS, CONDITIONS, DONE, SCRAPPED, SERIAL, SPEC, TYPES, MAKERS, CARRIERS };
