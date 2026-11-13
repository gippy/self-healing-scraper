export const BRAND = 'Gavel & Grain Auctions';

/** Raise this when the catalog changes; on startup a saved auction from another version is cleared and reseeded. */
export const CATALOG_VERSION = 'woodworking-1';

export type Category = { slug: string; name: string };

export type CatalogItem = { title: string; description: string; startingBid: number };

export const CATEGORIES: Category[] = [
  { slug: 'hand-tools', name: 'Hand Tools' },
  { slug: 'power-tools', name: 'Power Tools' },
  { slug: 'lumber', name: 'Lumber & Live-Edge Slabs' },
  { slug: 'chairs-stools', name: 'Chairs & Stools' },
  { slug: 'tables', name: 'Tables' },
  { slug: 'cabinets-storage', name: 'Cabinets & Storage' },
];

/** The file name of an item's product photo, from its title: `Vintage No. 4 Smoothing Plane` → `vintage-no-4-smoothing-plane`. */
export function getItemSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// What new lots are made of: every category has its own pool of items. Titles are unique across the catalog.
export const CATALOG: Record<string, CatalogItem[]> = {
  'hand-tools': [
    { title: 'Vintage No. 4 Smoothing Plane', description: 'Cast iron body, freshly flattened sole and a sharp iron. Takes whisper-thin shavings.', startingBid: 65 },
    { title: 'Low-Angle Block Plane', description: 'Fits in one hand and trims end grain cleanly. Adjustable mouth.', startingBid: 45 },
    { title: 'Set of Six Bevel-Edge Chisels', description: 'Ash handles, sizes from 1/4 to 1 inch, honed and ready.', startingBid: 85 },
    { title: 'Japanese Pull Saw, Ryoba Pattern', description: 'Rip teeth on one edge, crosscut on the other. Cuts on the pull stroke.', startingBid: 38 },
    { title: 'Brass-Backed Dovetail Saw', description: 'Fine teeth and a heavy brass spine for straight, tight joints.', startingBid: 70 },
    { title: 'Beech Marking Gauge', description: 'Brass wear strips and a crisp cutting pin. Holds its setting.', startingBid: 22 },
    { title: 'Cast Iron Spokeshave', description: 'Shapes chair spindles and curved edges. Flat sole, fine adjuster.', startingBid: 28 },
    { title: 'Card Scraper Set with Burnisher', description: 'Three scrapers and a hardened burnisher for glassy surfaces.', startingBid: 18 },
    { title: 'Rosewood Try Square, 9 Inch', description: 'Brass-faced stock, checked true against a machinist square.', startingBid: 26 },
    { title: 'Hand Brace with Auger Bits', description: 'Ten-inch sweep, ratchet chuck and a roll of seven auger bits.', startingBid: 48 },
    { title: 'Carving Gouge Set, Twelve Pieces', description: 'Palm-sized handles, assorted sweeps, in a canvas tool roll.', startingBid: 95 },
    { title: 'Combination Waterstone, 1000/6000', description: 'Medium and fine grit in one stone, with a non-slip base.', startingBid: 35 },
    { title: 'Mortise Chisel, 3/8 Inch', description: 'Thick blade and a hooped handle made for mallet work.', startingBid: 32 },
    { title: 'Joiner Mallet with Hardwood Head', description: 'Dense, heavy head and a tapered handle that never flies off.', startingBid: 30 },
    { title: 'Crosscut Panel Saw, 26 Inch', description: 'Taper-ground blade with a beech handle. Recently sharpened.', startingBid: 40 },
  ],
  'power-tools': [
    { title: 'Cordless Drill Driver Kit, Two Batteries', description: 'Two-speed gearbox, charger and a hard case.', startingBid: 90 },
    { title: 'Random Orbit Sander, 5 Inch', description: 'Variable speed, dust bag and a stack of assorted discs.', startingBid: 55 },
    { title: 'Plunge Router with Edge Guide', description: 'Two horsepower, soft start and both collets included.', startingBid: 150 },
    { title: 'Contractor Table Saw, 10 Inch', description: 'Cast iron top, folding stand and a good rip fence.', startingBid: 420 },
    { title: 'Sliding Compound Miter Saw', description: 'Twelve-inch blade with laser line. Cuts wide boards in one pass.', startingBid: 310 },
    { title: 'Benchtop Drill Press', description: 'Twelve speeds, tilting table and a keyed chuck.', startingBid: 180 },
    { title: 'Variable-Speed Jigsaw', description: 'Orbital action, bevel base and a dozen spare blades.', startingBid: 45 },
    { title: 'Biscuit Joiner in Carry Case', description: 'Adjustable fence for quick, aligned panel glue-ups.', startingBid: 95 },
    { title: 'Benchtop Thickness Planer, 13 Inch', description: 'Two-blade cutterhead and folding infeed tables.', startingBid: 340 },
    { title: 'Fourteen-Inch Bandsaw', description: 'Resaws boards up to six inches. Comes with three blades.', startingBid: 520 },
    { title: 'Midi Wood Lathe', description: 'Variable speed, twelve-inch swing and a tool rest.', startingBid: 380 },
    { title: 'Track Saw with Two Rails', description: 'Splinter-free cuts on sheet goods. Rails join to 110 inches.', startingBid: 360 },
    { title: 'Shop Dust Collector, 1.5 HP', description: 'Single stage with a fine filter bag and a wheeled base.', startingBid: 260 },
    { title: 'Oscillating Spindle Sander', description: 'Five drums and matching table inserts for smooth curves.', startingBid: 140 },
    { title: 'Detail Palm Sander', description: 'Triangle pad for corners and tight spots. Light and quiet.', startingBid: 30 },
  ],
  lumber: [
    { title: 'Black Walnut Live-Edge Slab, 6 Feet', description: 'Kiln dried, two inches thick, with a dramatic natural edge.', startingBid: 450 },
    { title: 'Spalted Maple Bowl Blanks, Set of Four', description: 'Dark zone lines through pale maple. Sealed ends.', startingBid: 60 },
    { title: 'Quartersawn White Oak, 20 Board Feet', description: 'Ray fleck on every face. Straight grain, ready to mill.', startingBid: 180 },
    { title: 'Cherry Boards, Bundle of Ten', description: 'Four-quarter stock that darkens to a rich red with time.', startingBid: 160 },
    { title: 'Olive Wood Turning Blanks', description: 'Swirled, fragrant grain for pens, handles and small bowls.', startingBid: 45 },
    { title: 'Hand-Hewn Reclaimed Barn Beam', description: 'Old-growth oak from a 19th-century barn, adze marks intact.', startingBid: 220 },
    { title: 'Curly Maple Guitar Top Set', description: 'Bookmatched pair with deep, even figure.', startingBid: 85 },
    { title: 'Live-Edge Elm Slab, Bench Length', description: 'Five feet long with a wavy edge, flattened on one side.', startingBid: 260 },
    { title: 'Hard Maple Butcher Block Blank', description: 'Edge-glued and sanded, ready for legs or a countertop.', startingBid: 130 },
    { title: 'Purpleheart Strips, Bundle', description: 'Vivid purple accent wood for inlays and cutting boards.', startingBid: 55 },
    { title: 'Burl Walnut Veneer Pack', description: 'Sequenced leaves for matching panels and box lids.', startingBid: 70 },
    { title: 'Thick Sapele Boards', description: 'Eight-quarter, ribbon-striped and stable. Great for tables.', startingBid: 150 },
    { title: 'Ash Bending Stock for Chairs', description: 'Straight-grained green ash, split from the log for steam bending.', startingBid: 40 },
    { title: 'Western Red Cedar Planks', description: 'Light, aromatic and weather resistant, for outdoor builds.', startingBid: 95 },
    { title: 'Bog Oak Offcuts', description: 'Black oak preserved in peat for thousands of years.', startingBid: 120 },
  ],
  'chairs-stools': [
    { title: 'Windsor Chair in Ash and Elm', description: 'Steam-bent bow back, hand-shaped seat and turned legs.', startingBid: 280 },
    { title: 'Shaker Ladder-Back Rocking Chair', description: 'Maple frame with a woven tape seat. Rocks quietly.', startingBid: 340 },
    { title: 'Three-Legged Milking Stool', description: 'Never wobbles on an uneven floor. Oiled oak.', startingBid: 45 },
    { title: 'Walnut Bar Stools, Pair', description: 'Counter height with sculpted seats and brass footrests.', startingBid: 260 },
    { title: 'Danish-Style Teak Lounge Chair', description: 'Low, wide seat with wool cushions and a sloped back.', startingBid: 520 },
    { title: "Child's Rush-Seat Chair", description: 'Small ladder-back chair with a hand-woven rush seat.', startingBid: 70 },
    { title: 'Bent Plywood Dining Chair', description: 'One-piece molded seat and back on solid beech legs.', startingBid: 110 },
    { title: 'Oak Church Pew, Six Feet', description: 'Reclaimed from a chapel. Seats three, worn smooth by decades of use.', startingBid: 300 },
    { title: 'Cherry Shop Stool with Footrest', description: 'Swivel seat and a footrest ring. Workbench height.', startingBid: 120 },
    { title: 'Folding Mahogany Campaign Chair', description: 'Leather sling seat; folds flat for travel.', startingBid: 190 },
    { title: 'Hand-Carved Rocking Horse', description: 'Painted dapple gray with a horsehair mane, on bow rockers.', startingBid: 210 },
    { title: 'Woven Cord Footstool', description: 'Danish cord seat on a square oak frame.', startingBid: 85 },
    { title: 'Spindle-Back Kitchen Chairs, Set of Four', description: 'Turned spindles and saddle seats in honey-toned pine.', startingBid: 360 },
    { title: 'Live-Edge Slab Bench', description: 'One walnut slab on splayed legs. Seats two.', startingBid: 240 },
    { title: 'Steam-Bent Ash Armchair', description: 'Continuous arm bent from one piece of ash.', startingBid: 310 },
  ],
  tables: [
    { title: 'Pine Farmhouse Dining Table', description: 'Seats eight. Breadboard ends and a scrubbed top.', startingBid: 520 },
    { title: 'Walnut Live-Edge Coffee Table', description: 'Book-matched slabs with a butterfly key on steel hairpin legs.', startingBid: 680 },
    { title: 'Shaker Side Table with Drawer', description: 'Tapered legs, dovetailed drawer and a wooden knob.', startingBid: 180 },
    { title: 'Oak Trestle Table, Eight Feet', description: 'Pegged trestle base that knocks down for moving.', startingBid: 750 },
    { title: 'Round Cherry Pedestal Table', description: 'Forty-two inches across on a turned column and three feet.', startingBid: 460 },
    { title: 'Drop-Leaf Gateleg Table', description: 'Folds to a narrow console and opens to seat six.', startingBid: 290 },
    { title: 'Split-Top Beech Workbench', description: 'Leg vise, wagon vise and a planing stop. Dead flat.', startingBid: 640 },
    { title: 'Teak Nesting Tables, Set of Three', description: 'Mid-century style; the three slide neatly into one.', startingBid: 240 },
    { title: 'Butcher Block Kitchen Island', description: 'Maple top with an open shelf and towel bars.', startingBid: 560 },
    { title: 'Solid Walnut Writing Desk', description: 'Two drawers with hand-cut dovetails and a leather inlay.', startingBid: 820 },
    { title: 'Maple Tavern Table', description: 'Small and sturdy with splayed legs and a breadboard top.', startingBid: 210 },
    { title: 'Quartersawn Oak Hall Console', description: 'Narrow, with a lower shelf and through-tenons.', startingBid: 330 },
    { title: "Child's Craft Table with Two Stools", description: 'Low birch table with a rounded edge and wipe-clean finish.', startingBid: 120 },
    { title: 'Parquet Game Table', description: 'Inlaid chessboard top and a drawer for the pieces.', startingBid: 270 },
    { title: 'Elm Bedside Table', description: 'One drawer and an open shelf, finished in hard wax oil.', startingBid: 140 },
  ],
  'cabinets-storage': [
    { title: "Oak Machinist's Tool Chest", description: 'Eleven felt-lined drawers and a lift-up lid.', startingBid: 420 },
    { title: 'Pine Blanket Chest', description: 'Dovetailed corners, a till inside and a milk-paint finish.', startingBid: 180 },
    { title: 'Walnut Wall Cabinet with Glass Door', description: 'Hand-cut joinery and a wooden turn latch.', startingBid: 360 },
    { title: 'Apothecary Cabinet, Thirty Drawers', description: 'Small labeled drawers with brass card holders.', startingBid: 540 },
    { title: 'Shaker Pegboard Shelf', description: 'Three-foot shelf with five turned maple pegs.', startingBid: 60 },
    { title: 'Cherry Bookcase, Five Shelves', description: 'Adjustable shelves and a crown molding top.', startingBid: 380 },
    { title: 'Dovetailed Keepsake Box', description: 'Walnut and maple with a lift-off lid. Fits in your hands.', startingBid: 75 },
    { title: 'Painted Pine Kitchen Hutch', description: 'Open plate rack above, two cupboards below.', startingBid: 450 },
    { title: 'Teak Mid-Century Sideboard', description: 'Sliding doors, tapered legs and four inner drawers.', startingBid: 690 },
    { title: 'Dutch Hanging Tool Cabinet', description: 'Sloped front with saw tills and chisel racks inside.', startingBid: 260 },
    { title: 'Reclaimed Oak Wine Rack', description: 'Holds twenty-four bottles. Built from old floorboards.', startingBid: 140 },
    { title: 'Library Card Catalog Drawers', description: 'Fifteen-drawer oak unit from a school library.', startingBid: 480 },
    { title: 'Spice Rack with Turned Spindles', description: 'Two shelves with turned rails. Mounts on the wall.', startingBid: 45 },
    { title: 'Wall-Mounted Lumber Rack', description: 'Six steel-reinforced oak arms for long boards.', startingBid: 90 },
    { title: 'Jewelry Box with Lift-Out Tray', description: 'Felt-lined, with a lift-out ring tray and a brass hinge.', startingBid: 95 },
  ],
};

/** Every catalog item, in category order. */
export function getCatalogItems(): CatalogItem[] {
  return CATEGORIES.flatMap((category) => CATALOG[category.slug] ?? []);
}
