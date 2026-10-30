/* Inspection category definitions, shared by the inspection report
   creation page (inspection.html ?new mode). Same shape for both kinds
   so one render engine, one report page, print, and share link serve both. */
const PPI_CATS = [
  { key: 'tires', label: 'Tires & tread depth', legend: 'Mark each tire: red = replace, yellow = suggest service soon, green = good', fields: [
    { k: 'Front left tread', ph: 'e.g. 7/32 in', band: true }, { k: 'Front right tread', ph: 'e.g. 7/32 in', band: true },
    { k: 'Rear left tread', ph: 'e.g. 7/32 in', band: true }, { k: 'Rear right tread', ph: 'e.g. 7/32 in', band: true },
    { k: 'Spare tire', ph: 'Present and inflated, or missing' } ] },
  { key: 'brakes', label: 'Brake inspection', legend: 'Mark each pad: red = replace (1–3 mm), yellow = suggest soon (4–7 mm), green = good (8–12 mm)', fields: [
    { k: 'Front pad thickness', ph: 'e.g. 8 mm', band: true }, { k: 'Rear pad thickness', ph: 'e.g. 6 mm', band: true },
    { k: 'Rotor condition', ph: 'Good / worn / warped / scored' } ] },
  { key: 'scan', label: 'Computer scan (all modules)', fields: [
    { k: 'Modules scanned', ph: 'e.g. Engine, transmission, ABS, airbag' },
    { k: 'Codes found', ph: 'List any codes, or "none"' } ] },
  { key: 'leaks', label: 'Current fluid leaks', fields: [
    { k: 'Leak location', ph: 'e.g. Valve cover, or "none seen"' }, { k: 'Fluid type', ph: 'e.g. Engine oil' } ] },
  { key: 'belts', label: 'Belt condition', fields: [
    { k: 'Serpentine belt', ph: 'Good / cracking / worn' }, { k: 'Timing belt or chain', ph: 'If visible or per records' } ] },
  { key: 'fluids', label: 'Oil level & fluid checks', fields: [
    { k: 'Engine oil level', ph: 'Full / low' }, { k: 'Engine oil condition', ph: 'Clean / dark / sludge' },
    { k: 'Coolant', ph: 'OK / low' }, { k: 'Brake fluid', ph: 'OK / low' }, { k: 'Transmission fluid', ph: 'OK / low' } ] },
  { key: 'suspension', label: 'Suspension & steering', fields: [] },
  { key: 'battery', label: 'Battery & charging', fields: [ { k: 'Battery voltage', ph: 'e.g. 12.6V' } ] },
  { key: 'lights', label: 'Lights & electrical', fields: [] },
  { key: 'cooling', label: 'Cooling system', fields: [] },
  { key: 'exhaust', label: 'Exhaust system', fields: [] },
  { key: 'body', label: 'Exterior, body & interior', fields: [] },
];

/* Complete vehicle inspection: the routine / pre-trip
   checklist. Same shape as PPI_CATS so both types share one form engine,
   one report page, print, and the share link. */
const CVI_CATS = [
  { key: 'tires', label: 'Tires & wheels', legend: 'Mark each tire: red = replace, yellow = suggest service soon, green = good', fields: [
    { k: 'Front left tread', ph: 'e.g. 7/32 in', band: true }, { k: 'Front right tread', ph: 'e.g. 7/32 in', band: true },
    { k: 'Rear left tread', ph: 'e.g. 7/32 in', band: true }, { k: 'Rear right tread', ph: 'e.g. 7/32 in', band: true },
    { k: 'Tire pressure', ph: 'e.g. 35 psi all around' }, { k: 'Wear & damage', ph: 'Uneven wear, cracks, bulges, or none seen' },
    { k: 'Spare tire', ph: 'Present and inflated, or missing' } ] },
  { key: 'brakes', label: 'Brakes', legend: 'Mark each pad: red = replace (1–3 mm), yellow = suggest soon (4–7 mm), green = good (8–12 mm)', fields: [
    { k: 'Front pad thickness', ph: 'e.g. 8 mm', band: true }, { k: 'Rear pad thickness', ph: 'e.g. 6 mm', band: true },
    { k: 'Rotor condition', ph: 'Good / worn / warped / scored' }, { k: 'Brake lines & hoses', ph: 'Good / cracked / leaking' },
    { k: 'Parking brake', ph: 'Holds / weak / not working' } ] },
  { key: 'fluids', label: 'Fluids', fields: [
    { k: 'Engine oil level', ph: 'Full / low' }, { k: 'Engine oil condition', ph: 'Clean / dark / sludge' },
    { k: 'Coolant level', ph: 'Full / low' }, { k: 'Brake fluid', ph: 'OK / low' },
    { k: 'Power steering fluid', ph: 'OK / low' }, { k: 'Transmission fluid', ph: 'OK / low' },
    { k: 'Washer fluid', ph: 'Full / low' } ] },
  { key: 'belts', label: 'Belts & hoses', fields: [
    { k: 'Serpentine belt', ph: 'Good / cracking / worn' }, { k: 'Hoses & clamps', ph: 'Good / soft / swollen / leaking' },
    { k: 'Timing belt or chain', ph: 'If visible or per records' } ] },
  { key: 'battery', label: 'Battery & charging', fields: [
    { k: 'Battery voltage', ph: 'e.g. 12.6V' }, { k: 'Terminals & corrosion', ph: 'Clean / corroded' },
    { k: 'Hold-down & cables', ph: 'Secure / loose / damaged' } ] },
  { key: 'engine', label: 'Engine', fields: [
    { k: 'Oil leaks', ph: 'None seen / location' }, { k: 'Coolant leaks', ph: 'None seen / location' },
    { k: 'Unusual noises', ph: 'None / knocking / ticking / other' }, { k: 'Engine air filter', ph: 'Clean / dirty / replace' },
    { k: 'Mounts', ph: 'Good / worn / broken' } ] },
  { key: 'drivetrain', label: 'Transmission & drivetrain', fields: [
    { k: 'Transmission fluid condition', ph: 'Clean / dark / burnt' }, { k: 'Transmission leaks', ph: 'None seen / location' },
    { k: 'Shifting feel', ph: 'Smooth / harsh / slipping' }, { k: 'CV boots', ph: 'Good / torn / leaking' },
    { k: 'U-joints', ph: 'Good / loose / noisy' }, { k: 'Differential / transfer case', ph: 'Fluid OK / leaking / noisy' } ] },
  { key: 'suspension', label: 'Suspension & steering', fields: [
    { k: 'Shocks & struts', ph: 'Good / leaking / worn' }, { k: 'Ball joints', ph: 'Good / loose' },
    { k: 'Tie rods', ph: 'Good / loose' }, { k: 'Bushings', ph: 'Good / cracked / worn' },
    { k: 'Steering play', ph: 'None / slight / excessive' } ] },
  { key: 'exhaust', label: 'Exhaust system', fields: [
    { k: 'Muffler', ph: 'Good / rusted / holed' }, { k: 'Pipes & mounts', ph: 'Good / rusted / loose' },
    { k: 'Catalytic converter', ph: 'Good / rattling / damaged' }, { k: 'Exhaust leaks', ph: 'None / location' } ] },
  { key: 'cooling', label: 'Cooling system', fields: [
    { k: 'Radiator', ph: 'Good / leaking / clogged fins' }, { k: 'Fan operation', ph: 'Kicks on / not working' },
    { k: 'Water pump signs', ph: 'Dry / weeping / noisy' }, { k: 'Temperature behavior', ph: 'Normal / runs hot' } ] },
  { key: 'lights', label: 'Lights & electrical', fields: [
    { k: 'Headlights', ph: 'Both working / one out' }, { k: 'Taillights', ph: 'Working / out' },
    { k: 'Turn signals', ph: 'Working / fast / out' }, { k: 'Brake lights', ph: 'Working / out' },
    { k: 'Hazard lights', ph: 'Working / out' }, { k: 'Horn', ph: 'Working / weak / not working' },
    { k: 'Dash warning lights', ph: 'None on / list any lit' } ] },
  { key: 'wipers', label: 'Wipers, glass & mirrors', fields: [
    { k: 'Wiper blades', ph: 'Good / streaking / torn' }, { k: 'Washer spray', ph: 'Strong / weak / clogged' },
    { k: 'Windshield', ph: 'Clear / chips / cracks' }, { k: 'Mirrors', ph: 'Good / cracked / loose' } ] },
  { key: 'cabin', label: 'Climate, cabin & safety', fields: [
    { k: 'A/C cooling', ph: 'Cold / weak / not working' }, { k: 'Heat', ph: 'Working / weak' },
    { k: 'Cabin air filter', ph: 'Clean / dirty / replace' }, { k: 'Seat belts', ph: 'Good / frayed / latch issues' },
    { k: 'Interior condition', ph: 'Good / wear noted' } ] },
  { key: 'scan', label: 'Computer scan', fields: [
    { k: 'Modules scanned', ph: 'e.g. Engine, transmission, ABS, airbag' },
    { k: 'Codes found', ph: 'List any codes, or "none"' } ] },
  { key: 'roadtest', label: 'Road test', fields: [
    { k: 'Braking feel', ph: 'Firm / soft / pulling' }, { k: 'Steering pull or drift', ph: 'Straight / pulls left / pulls right' },
    { k: 'Acceleration', ph: 'Normal / hesitation / surging' }, { k: 'Unusual noises', ph: 'None / describe' },
    { k: 'Cruise / driver assists', ph: 'Working / not equipped / fault' } ] },
];
